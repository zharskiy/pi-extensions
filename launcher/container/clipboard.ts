import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { type Backend, execCapture, type MountSpec } from "../backend/index.ts";
import { visibleInside } from "./host-paths.ts";

export interface HostClipboard {
  copy(text: Buffer): Promise<unknown>;
  readImage(): Promise<Buffer | undefined>;
  mounts: MountSpec[];
}

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

const unterminated = (text: string) => {
  const tail = text.slice(Math.max(text.lastIndexOf(OSC52_OPENER), 0));

  if (tail.startsWith(OSC52_OPENER) && !tail.includes(BEL) && !tail.includes(ST)) {
    return tail;
  }

  const partial = [4, 3, 2, 1].find((length) => text.endsWith(OSC52_OPENER.slice(0, length)));

  return partial === undefined ? "" : text.slice(-partial);
};

export const copyTee = (stdout: NodeJS.WritableStream, copy: HostClipboard["copy"]) => {
  const state = { carry: "", copying: Promise.resolve<unknown>(undefined) };

  const scan = (chunk: Buffer) => {
    const text = state.carry + chunk.toString("latin1");
    const writes = [...text.matchAll(OSC52)];
    const carry = unterminated(text);

    state.carry = carry.length > CARRY_MAX ? "" : carry;

    writes.forEach(([, base64]) => {
      state.copying = state.copying.then(() => copy(Buffer.from(base64, "base64"))).catch(() => undefined);
    });
  };

  return new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      scan(chunk);

      if (stdout.write(chunk)) {
        done();

        return;
      }

      void once(stdout, "drain").then(() => done(), done);
    },
  });
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

const hostPath = (text: string) => {
  const quoted = /^(['"])(.*)\1$/s.exec(text);
  const path = quoted === null ? text.replace(/\\(.)/gs, "$1") : quoted[2];

  return path?.startsWith("/") === true ? path : undefined;
};

const pastedImage = async (path: string, mounts: MountSpec[]) => {
  const extension = extname(path).toLowerCase();

  if (!IMAGE_EXTENSIONS.includes(extension)) {
    return undefined;
  }

  const real = await realpath(path);

  if (visibleInside(path, mounts) && visibleInside(real, mounts)) {
    return undefined;
  }

  const entry = await stat(real);

  return entry.isFile() && entry.size <= IMAGE_MAX_BYTES
    ? { data: await readFile(real), extension }
    : undefined;
};

const bracketed = (text: string) => Buffer.from(`${ESC}[200~${text}${ESC}[201~`);

const rewrittenPaste = async (body: string, trailing: string, sandbox: Sandbox, clipboard: HostClipboard) => {
  const path = hostPath(body);
  const image = path === undefined ? undefined : await pastedImage(path, clipboard.mounts);
  const guestPath = image === undefined ? undefined : await copiedIn(image.data, image.extension, sandbox);

  return guestPath === undefined ? undefined : bracketed(`${guestPath}${trailing}`);
};

const clipboardPaste = async (sandbox: Sandbox, clipboard: HostClipboard) => {
  const image = await clipboard.readImage();

  if (image === undefined || image.length > IMAGE_MAX_BYTES) {
    return undefined;
  }

  const guestPath = await copiedIn(image, ".png", sandbox);

  return guestPath === undefined ? undefined : bracketed(guestPath);
};

const rewritten = async (chunk: Buffer, sandbox: Sandbox, clipboard: HostClipboard) => {
  const text = chunk.toString("utf8");
  const paste = PASTE.exec(text);

  if (paste !== null) {
    return await rewrittenPaste(paste[1] ?? "", paste[2] ?? "", sandbox, clipboard);
  }

  return CTRL_V.test(text) ? await clipboardPaste(sandbox, clipboard) : undefined;
};

export const pasteBridge = (stdin: NodeJS.ReadableStream, sandbox: Sandbox, clipboard: HostClipboard) => {
  const input = new PassThrough();
  const queue = { tail: Promise.resolve() };

  const receive = (data: Buffer | string) => {
    const chunk = Buffer.from(data);

    queue.tail = queue.tail
      .then(() => rewritten(chunk, sandbox, clipboard))
      .catch(() => undefined)
      .then((replaced) => {
        input.write(replaced ?? chunk);
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
