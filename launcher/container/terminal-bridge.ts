import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { type Backend, execCapture, type MountSpec } from "../backend/index.ts";
import { CtrlVScanner, type KeySegment } from "./ctrl-v.ts";
import { visibleInside } from "./host-paths.ts";
import { Osc52Filter, type Osc52Segment } from "./osc52.ts";
import {
  BracketedPasteSplitter,
  bracketed,
  IMAGE_HEADER_BYTES,
  imageExtensionOf,
  OrderedInput,
  type PathToken,
  pathTokens,
  withReplacedPaths,
} from "./paste.ts";

export type HostClipboard = (text: Buffer) => Promise<boolean>;

export type HostClipboardImage = () => Promise<Buffer | undefined>;

type Copy = Extract<Osc52Segment, { kind: "copy" }>;

interface PastedImage {
  data: Buffer;
  extension: string;
}

export interface PasteTarget {
  backend: Pick<Backend, "exec">;
  containerId: string;
  mounts: MountSpec[];
  recentCopy?: () => string | undefined;
  readImage?: (path: string, mounts: MountSpec[]) => Promise<PastedImage | undefined>;
  readClipboardImage?: HostClipboardImage;
}

interface Deadline {
  ms: number;
  stalled: WeakMap<PasteTarget, number>;
}

export const PASTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export const PASTE_CHECK_TIMEOUT_MS = 2000;

export const CLIPBOARD_READ_TIMEOUT_MS = 5000;

export const CTRL_V_IDLE_MS = 100;

export const GUEST_PASTE_DIR = "/tmp/pi-paste";

const PASTE_MAX_PATHS = 16;

const PASTE_COPY_TIMEOUT_MS = 10_000;

const COPY_SCRIPT = `umask 077 && mkdir -p ${GUEST_PASTE_DIR} && set -C && cat > "$1"`;

const latestCopies = (clipboard: HostClipboard, failed: (copy: Copy) => void) => {
  const state: { running: boolean; next?: Copy } = { running: false };

  const run = (copy: Copy) => {
    state.running = true;

    void clipboard(copy.text)
      .catch(() => false)
      .then((copied) => {
        if (!copied) {
          failed(copy);
        }

        const next = state.next;

        state.next = undefined;
        state.running = false;

        if (next !== undefined) {
          run(next);
        }
      });
  };

  return (copy: Copy) => {
    if (state.running) {
      state.next = copy;

      return;
    }

    run(copy);
  };
};

export const copyBridge = (stdout: NodeJS.WritableStream, clipboard: HostClipboard) => {
  const filter = new Osc52Filter();
  const recent: { text?: string } = {};
  const copy = latestCopies(clipboard, (failed) => stdout.write(failed.sequence));

  const writeSegments = (segments: Osc52Segment[]) =>
    segments
      .map((segment) => {
        if (segment.kind === "pass") {
          return stdout.write(segment.bytes);
        }

        recent.text = segment.text.toString("utf8");

        copy(segment);

        return true;
      })
      .every(Boolean);

  const output = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      if (writeSegments(filter.push(chunk))) {
        done();

        return;
      }

      void once(stdout, "drain").then(() => done(), done);
    },
  });

  const failed = (error: Error) => {
    output.destroy(error);
  };

  output.on("error", () => undefined);

  stdout.on("error", failed);

  const release = () => {
    stdout.off("error", failed);

    writeSegments(filter.flush());
  };

  return { output, release, recentCopy: () => recent.text };
};

const imageBytes = async (path: string, mounts: MountSpec[]): Promise<PastedImage | undefined> => {
  const real = await realpath(path);

  if (visibleInside(path, mounts) && visibleInside(real, mounts)) {
    return undefined;
  }

  const entry = await stat(real);

  if (!entry.isFile() || entry.size === 0 || entry.size > PASTE_IMAGE_MAX_BYTES) {
    return undefined;
  }

  const handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK);

  try {
    const opened = await handle.stat();

    if (!opened.isFile() || opened.size > PASTE_IMAGE_MAX_BYTES) {
      return undefined;
    }

    const header = Buffer.alloc(IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, IMAGE_HEADER_BYTES, 0);

    if (imageExtensionOf(header.subarray(0, bytesRead)) === undefined) {
      return undefined;
    }

    const data = await handle.readFile();
    const extension = imageExtensionOf(data.subarray(0, IMAGE_HEADER_BYTES));

    return extension === undefined || data.length > PASTE_IMAGE_MAX_BYTES ? undefined : { data, extension };
  } finally {
    await handle.close();
  }
};

const importedImage = async (image: PastedImage | undefined, target: PasteTarget) => {
  if (image === undefined) {
    return undefined;
  }

  const guestPath = `${GUEST_PASTE_DIR}/${randomUUID()}.${image.extension}`;
  const copied = await execCapture(
    target.backend,
    {
      containerId: target.containerId,
      command: ["sh", "-c", COPY_SCRIPT, "sh", guestPath],
      env: {},
      workdir: "/",
    },
    image.data,
    PASTE_COPY_TIMEOUT_MS,
  ).catch(() => undefined);

  return copied?.code === 0 ? guestPath : undefined;
};

const PATH_CHECKS: Deadline = { ms: PASTE_CHECK_TIMEOUT_MS, stalled: new WeakMap() };

const CLIPBOARD_READS: Deadline = { ms: CLIPBOARD_READ_TIMEOUT_MS, stalled: new WeakMap() };

const stalledCount = (deadline: Deadline, target: PasteTarget) => deadline.stalled.get(target) ?? 0;

const withinDeadline = async <T>(work: Promise<T>, target: PasteTarget, deadline: Deadline) => {
  const timer: { id?: NodeJS.Timeout } = {};
  const expired = new Promise<undefined>((resolve) => {
    timer.id = setTimeout(() => {
      deadline.stalled.set(target, stalledCount(deadline, target) + 1);

      void work.finally(() => deadline.stalled.set(target, stalledCount(deadline, target) - 1));

      resolve(undefined);
    }, deadline.ms);
  });

  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer.id);
  }
};

const withoutControls = (text: string) =>
  [...text].filter((character) => character >= " " && character !== "\x7f").join("");

const copiedSpellings = (text: string, token: PathToken) => {
  const source = text.slice(token.start, token.end);

  return [token.path, source, token.quote === "" ? source : source.slice(1, -1)].map(withoutControls);
};

export const rewrittenPaste = async (body: Buffer, target: PasteTarget) => {
  const text = body.toString("utf8");

  if (!Buffer.from(text, "utf8").equals(body)) {
    return body;
  }

  if (stalledCount(PATH_CHECKS, target) > 0) {
    return body;
  }

  const copied = withoutControls(target.recentCopy?.() ?? "");
  const tokens = pathTokens(text)
    .filter(
      (token) => copied === "" || !copiedSpellings(text, token).some((spelling) => copied.includes(spelling)),
    )
    .slice(0, PASTE_MAX_PATHS);
  const readImage = target.readImage ?? imageBytes;
  const images = await withinDeadline(
    Promise.all(tokens.map((token) => readImage(token.path, target.mounts).catch(() => undefined))),
    target,
    PATH_CHECKS,
  );

  if (images === undefined) {
    return body;
  }

  const imported = await Promise.all(
    tokens.map(async (token, index) => ({ token, path: await importedImage(images[index], target) })),
  );
  const replacements = imported.flatMap(({ token, path }) => (path === undefined ? [] : [{ token, path }]));

  return replacements.length === 0 ? body : Buffer.from(withReplacedPaths(text, replacements), "utf8");
};

const clipboardImage = (data: Buffer | undefined): PastedImage | undefined => {
  if (data === undefined || data.length === 0 || data.length > PASTE_IMAGE_MAX_BYTES) {
    return undefined;
  }

  const extension = imageExtensionOf(data.subarray(0, IMAGE_HEADER_BYTES));

  return extension === undefined ? undefined : { data, extension };
};

export const clipboardPaste = async (key: Buffer, target: PasteTarget) => {
  const read = target.readClipboardImage;

  if (read === undefined || stalledCount(CLIPBOARD_READS, target) > 0) {
    return key;
  }

  const image = await withinDeadline(
    read().then(clipboardImage, () => undefined),
    target,
    CLIPBOARD_READS,
  );
  const path = await importedImage(image, target);

  return path === undefined ? key : bracketed(Buffer.from(path, "utf8"));
};

export const pasteBridge = (stdin: NodeJS.ReadableStream, target: PasteTarget) => {
  const input = new PassThrough();
  const splitter = new BracketedPasteSplitter();

  const ordered = new OrderedInput((bytes) => {
    if (input.write(bytes)) {
      return;
    }

    stdin.pause();

    input.once("drain", () => stdin.resume());
  });

  const scanner = target.readClipboardImage === undefined ? undefined : new CtrlVScanner();
  const busy = { importing: false };
  const idle: { timer?: NodeJS.Timeout } = {};

  const pasteImage = (key: Buffer) => {
    if (busy.importing) {
      return;
    }

    busy.importing = true;

    ordered.pushLater(
      clipboardPaste(key, target).finally(() => {
        busy.importing = false;
      }),
      key,
    );
  };

  const deliverKeys = (segments: KeySegment[]) =>
    segments.forEach((segment) => {
      if (segment.kind === "keys") {
        ordered.push(segment.bytes);

        return;
      }

      pasteImage(segment.bytes);
    });

  const armIdle = () => {
    clearTimeout(idle.timer);

    if (scanner?.waiting() !== true) {
      return;
    }

    idle.timer = setTimeout(() => {
      deliverKeys(scanner.idle());

      armIdle();
    }, CTRL_V_IDLE_MS);
  };

  const deliver = (segments: ReturnType<BracketedPasteSplitter["push"]>) =>
    segments.forEach((segment) => {
      if (segment.kind === "keys") {
        deliverKeys(scanner === undefined ? [segment] : scanner.push(segment.bytes));

        return;
      }

      deliverKeys(scanner?.pasted() ?? []);

      const raw = bracketed(segment.body);

      ordered.pushLater(rewrittenPaste(segment.body, target).then(bracketed), raw);
    });

  const receive = (chunk: Buffer | string) => {
    deliver(splitter.push(Buffer.from(chunk)));

    armIdle();
  };

  const ended = () => {
    clearTimeout(idle.timer);

    deliver(splitter.flush());

    deliverKeys(scanner?.flush() ?? []);

    void ordered.settled().then(() => input.end());
  };

  stdin.on("data", receive);

  stdin.once("end", ended);

  const stop = () => {
    clearTimeout(idle.timer);

    stdin.off("data", receive);

    stdin.off("end", ended);

    stdin.pause();
  };

  return { input, stop };
};
