import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { type Backend, execCapture, type MountSpec } from "../backend/index.ts";
import { visibleInside } from "./host-paths.ts";

export type ClipboardContent = { image: Buffer } | { file: string };

export interface HostClipboard {
  copy(text: Buffer): Promise<unknown>;
  read(): Promise<ClipboardContent | undefined>;
  mounts: MountSpec[];
}

type Rewrite = { replaced?: Buffer; notice?: string };

interface Sandbox {
  backend: Pick<Backend, "exec">;
  containerId: string;
}

const ESC = "\x1b";

const BEL = "\x07";

const ST = `${ESC}\\`;

const OSC52_OPENER = `${ESC}]52;`;

const OSC52 = new RegExp(String.raw`${ESC}\]52;[^;${BEL}${ESC}]*;([A-Za-z0-9+/=]+)(?:${BEL}|${ESC}\\)`, "g");

const CARRY_MAX = 1024 * 1024;

const PASTE = new RegExp(String.raw`^${ESC}\[200~(.*?)(\s*)${ESC}\[201~$`, "s");

const CTRL_V = new RegExp(
  String.raw`^(?:\x16|${ESC}\[(?:118|\d+:\d*:118);(?:5|69|133|197)(?::[12])?u|${ESC}\[27;5;118~)$`,
);

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const GUEST_DIR = "/tmp/pi-paste";

const COPY_TIMEOUT_MS = 10_000;

const COPY_SCRIPT = `umask 077 && mkdir -p ${GUEST_DIR} && cat > "$1"`;

const NOT_COPIED = "pi-sandbox: image not copied into the sandbox:";

const DENIED_NOTICE = `${NOT_COPIED} macOS blocked the terminal from reading it; allow access in System Settings → Privacy & Security → Files and Folders`;

const GONE_NOTICE = `${NOT_COPIED} there is no such file on the host`;

const NOT_FILE_NOTICE = `${NOT_COPIED} it is not a regular file`;

const TOO_LARGE_NOTICE = `${NOT_COPIED} it is larger than 20 MiB`;

const COPY_FAILED_NOTICE = `${NOT_COPIED} the copy into the container failed`;

const OPEN_ESCAPE = new RegExp(String.raw`^${ESC}(?:\[[\x20-\x3f]*|[\]P^_X][^${BEL}${ESC}]*|[\x20-\x2f]*)$`);

const control = (text: string) =>
  [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;

    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

const notification = (notice: string) => `${ESC}]9;${notice}${BEL}`;

const openEscape = (previous: string, text: string) => {
  const at = text.lastIndexOf(ESC);
  const tail = at === -1 ? previous + text : text.slice(at);

  return tail.length <= CARRY_MAX && OPEN_ESCAPE.test(tail) ? tail : "";
};

const splitCharacter = (chunk: Buffer) => {
  const back = [1, 2, 3].find((offset) => ((chunk.at(-offset) ?? 0) & 0xc0) === 0xc0);
  const lead = back === undefined ? 0 : (chunk.at(-back) ?? 0);
  const needed = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : 1;

  return back !== undefined && back - 1 < needed;
};

const unterminated = (text: string) => {
  const tail = text.slice(Math.max(text.lastIndexOf(OSC52_OPENER), 0));

  if (tail.startsWith(OSC52_OPENER) && !tail.includes(BEL) && !tail.includes(ST)) {
    return tail;
  }

  const partial = [4, 3, 2, 1].find((length) => text.endsWith(OSC52_OPENER.slice(0, length)));

  return partial === undefined ? "" : text.slice(-partial);
};

export const copyTee = (stdout: NodeJS.WritableStream, copy: HostClipboard["copy"]) => {
  const state = {
    carry: "",
    escape: "",
    split: false,
    held: [] as string[],
    copying: Promise.resolve<unknown>(undefined),
  };

  const scan = (chunk: Buffer) => {
    const latin = chunk.toString("latin1");
    const text = state.carry + latin;
    const writes = [...text.matchAll(OSC52)];
    const carry = unterminated(text);

    state.carry = carry.length > CARRY_MAX ? "" : carry;
    state.escape = openEscape(state.escape, latin);
    state.split = splitCharacter(chunk);

    writes.forEach(([, base64]) => {
      state.copying = state.copying.then(() => copy(Buffer.from(base64, "base64"))).catch(() => undefined);
    });
  };

  const grounded = () => state.escape === "" && !state.split;

  const notify = (notice: string) => {
    if (grounded()) {
      stdout.write(notification(notice));

      return;
    }

    state.held.push(notification(notice));
  };

  const released = () => {
    const held = state.held.join("");

    state.held = [];

    return held;
  };

  const tee = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      scan(chunk);

      const written = stdout.write(chunk);

      if (grounded() && state.held.length > 0) {
        stdout.write(released());
      }

      if (written) {
        done();

        return;
      }

      void once(stdout, "drain").then(() => done(), done);
    },
  });

  return Object.assign(tee, { notify });
};

const copiedIn = async (data: Buffer, extension: string, sandbox: Sandbox) => {
  const guestPath = `${GUEST_DIR}/${randomUUID()}${extension}`;
  const copied = await execCapture(
    sandbox.backend,
    {
      containerId: sandbox.containerId,
      command: ["sh", "-c", COPY_SCRIPT, "sh", guestPath],
      env: {},
      workdir: "/",
    },
    data,
    COPY_TIMEOUT_MS,
  );

  return copied.code === 0 ? guestPath : undefined;
};

const SEVERAL_PATHS = /(?<!\\) \//;

const hostPath = (text: string) => {
  const [, quote, inner] = /^(['"])(.*)\1$/s.exec(text) ?? [];
  const several = quote === undefined ? SEVERAL_PATHS.test(text) : inner?.includes(quote) === true;

  if (several) {
    return undefined;
  }

  const path = quote === undefined ? text.replace(/\\(.)/gs, "$1") : inner;

  return path?.startsWith("/") === true ? path : undefined;
};

const readNotice = (error: unknown) => {
  const code = error instanceof Error && "code" in error ? String(error.code) : undefined;

  if (code === "EPERM" || code === "EACCES") {
    return DENIED_NOTICE;
  }

  return code === "ENOENT" ? GONE_NOTICE : `${NOT_COPIED} ${code ?? "reading it failed"}`;
};

type HostImage = { visible: true } | { notice: string } | { data: Buffer };

const hostImage = async (path: string, mounts: MountSpec[]): Promise<HostImage> => {
  const real = await realpath(path).catch((error: unknown) =>
    visibleInside(path, mounts) ? undefined : Promise.reject(error),
  );

  if (real === undefined || (visibleInside(path, mounts) && visibleInside(real, mounts))) {
    return { visible: true };
  }

  const entry = await stat(real);

  if (!entry.isFile()) {
    return { notice: NOT_FILE_NOTICE };
  }

  return entry.size > IMAGE_MAX_BYTES ? { notice: TOO_LARGE_NOTICE } : { data: await readFile(real) };
};

const importedImage = async (path: string, sandbox: Sandbox, clipboard: HostClipboard) => {
  const extension = extname(path).toLowerCase();

  if (!IMAGE_EXTENSIONS.includes(extension)) {
    return undefined;
  }

  const found = await hostImage(path, clipboard.mounts).catch((error: unknown) => ({
    notice: readNotice(error),
  }));

  if (!("data" in found)) {
    return found;
  }

  const guestPath = await copiedIn(found.data, extension, sandbox).catch(() => undefined);

  return guestPath === undefined ? { notice: COPY_FAILED_NOTICE } : { guestPath };
};

const bracketed = (text: string) => Buffer.from(`${ESC}[200~${text}${ESC}[201~`);

const rewrittenPaste = async (body: string, trailing: string, sandbox: Sandbox, clipboard: HostClipboard) => {
  const path = hostPath(body);
  const imported = path === undefined ? undefined : await importedImage(path, sandbox, clipboard);

  if (imported === undefined || "visible" in imported) {
    return {};
  }

  return "notice" in imported ? imported : { replaced: bracketed(`${imported.guestPath}${trailing}`) };
};

const filePaste = async (path: string, sandbox: Sandbox, clipboard: HostClipboard) => {
  const imported = await importedImage(path, sandbox, clipboard);

  if (imported === undefined) {
    return {};
  }

  if ("visible" in imported) {
    return control(path) ? {} : { replaced: bracketed(path) };
  }

  return "notice" in imported ? imported : { replaced: bracketed(imported.guestPath) };
};

const clipboardPaste = async (sandbox: Sandbox, clipboard: HostClipboard) => {
  const content = await clipboard.read();

  if (content !== undefined && "file" in content) {
    return await filePaste(content.file, sandbox, clipboard);
  }

  if (content === undefined || content.image.length > IMAGE_MAX_BYTES) {
    return {};
  }

  const guestPath = await copiedIn(content.image, ".png", sandbox);

  return guestPath === undefined ? {} : { replaced: bracketed(guestPath) };
};

const rewritten = async (chunk: Buffer, sandbox: Sandbox, clipboard: HostClipboard): Promise<Rewrite> => {
  const text = chunk.toString("utf8");
  const paste = PASTE.exec(text);

  if (paste !== null) {
    return await rewrittenPaste(paste[1] ?? "", paste[2] ?? "", sandbox, clipboard);
  }

  return CTRL_V.test(text) ? await clipboardPaste(sandbox, clipboard) : {};
};

export const pasteBridge = (
  stdin: NodeJS.ReadableStream,
  sandbox: Sandbox,
  clipboard: HostClipboard,
  notify: (notice: string) => void,
) => {
  const input = new PassThrough();
  const queue = { tail: Promise.resolve() };

  const receive = (data: Buffer | string) => {
    const chunk = Buffer.from(data);

    queue.tail = queue.tail
      .then(() => rewritten(chunk, sandbox, clipboard))
      .catch((): Rewrite => ({}))
      .then(({ replaced, notice }) => {
        input.write(replaced ?? chunk);

        if (notice !== undefined) {
          notify(notice);
        }
      });
  };

  const ended = () => {
    void queue.tail.then(() => input.end());
  };

  stdin.on("data", receive);

  stdin.once("end", ended);

  const stop = () => {
    stdin.off("data", receive);

    stdin.off("end", ended);

    stdin.pause();
  };

  return { input, stop };
};
