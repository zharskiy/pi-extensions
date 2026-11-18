import { spawnSync } from "node:child_process";
import { realpath, truncate } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ExecIo, ExecSpec, MountSpec } from "../../backend/index.ts";
import {
  copyBridge,
  GUEST_PASTE_DIR,
  PASTE_CHECK_TIMEOUT_MS,
  PASTE_IMAGE_MAX_BYTES,
  type PasteTarget,
  pasteBridge,
  rewrittenPaste,
} from "../../container/terminal-bridge.ts";
import { tempDir, writeText } from "../support/temp-dir.ts";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 1)]);

const GUEST_PATH = new RegExp(`^${GUEST_PASTE_DIR}/[0-9a-f-]{36}\\.(png|jpg|gif|webp)$`);

interface Copy {
  path: string;
  bytes: Buffer;
}

const readAll = async (stream: NodeJS.ReadableStream | undefined) => {
  const chunks: Buffer[] = [];

  if (stream !== undefined) {
    await new Promise<void>((resolve) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));

      stream.once("end", () => resolve());
    });
  }

  return Buffer.concat(chunks);
};

const guestBackend = (options: { code?: number; gate?: Promise<void> } = {}) => {
  const copies: Copy[] = [];
  const backend: PasteTarget["backend"] = {
    exec: async (spec: ExecSpec, io: ExecIo) => {
      const bytes = await readAll(io.stdin);

      await options.gate;

      copies.push({ path: spec.command.at(-1) ?? "", bytes });

      return options.code ?? 0;
    },
  };

  return { backend, copies };
};

const target = (backend: PasteTarget["backend"], mounts: MountSpec[] = []): PasteTarget => ({
  backend,
  containerId: "container-1",
  mounts,
});

const bind = (path: string): MountSpec => ({ source: path, target: path, readOnly: false, kind: "bind" });

const hostDir = async () => realpath(await tempDir("paste"));

const rewrite = async (text: string, pasteTarget: PasteTarget) =>
  (await rewrittenPaste(Buffer.from(text), pasteTarget)).toString();

describe("rewrittenPaste", () => {
  it("copies a pasted image into the sandbox and swaps in its path", async () => {
    const dir = await hostDir();
    const shot = join(dir, "My Shot.png");
    const guest = guestBackend();

    await writeText(shot, PNG);

    const text = await rewrite(`${shot.replaceAll(" ", "\\ ")} `, target(guest.backend));

    expect(text).toMatch(/^\/tmp\/pi-paste\/[0-9a-f-]{36}\.png $/);
    expect(guest.copies).toEqual([{ path: text.trim(), bytes: PNG }]);
    expect(text.trim()).toMatch(GUEST_PATH);
  });

  it("keeps the quoting of quoted paths and handles several paths", async () => {
    const dir = await hostDir();
    const one = join(dir, "one shot.png");
    const two = join(dir, "two.jpg");
    const guest = guestBackend();

    await writeText(one, PNG);

    await writeText(two, JPEG);

    const text = await rewrite(`'${one}' "${two}"`, target(guest.backend));
    const [first, second] = guest.copies.map((copy) => copy.path).sort();

    expect(text).toMatch(/^'\/tmp\/pi-paste\/[0-9a-f-]{36}\.png' "\/tmp\/pi-paste\/[0-9a-f-]{36}\.jpg"$/);
    expect([first, second].every((path) => text.includes(path ?? "?"))).toBe(true);
  });

  it("leaves non-images, oversized files, folders, fifos and missing paths alone", async () => {
    const dir = await hostDir();
    const notes = join(dir, "notes.png");
    const huge = join(dir, "huge.png");
    const fifo = join(dir, "pipe.png");
    const guest = guestBackend();

    await writeText(notes, "just text");

    await writeText(huge, PNG);

    await truncate(huge, PASTE_IMAGE_MAX_BYTES + 1);

    spawnSync("sh", ["-c", 'mkfifo "$1"', "sh", fifo]);

    const pasted = `${notes} ${huge} ${dir} ${fifo} ${join(dir, "gone.png")}`;

    expect(await rewrite(pasted, target(guest.backend))).toBe(pasted);
    expect(guest.copies).toEqual([]);
  });

  it("leaves a path the sandbox already sees at the same place alone", async () => {
    const dir = await hostDir();
    const shot = join(dir, "shot.png");
    const guest = guestBackend();

    await writeText(shot, PNG);

    expect(await rewrite(shot, target(guest.backend, [bind(dir)]))).toBe(shot);
    expect(guest.copies).toEqual([]);
  });

  it("leaves the path when the copy into the sandbox fails", async () => {
    const dir = await hostDir();
    const shot = join(dir, "shot.png");
    const guest = guestBackend({ code: 1 });

    await writeText(shot, PNG);

    expect(await rewrite(shot, target(guest.backend))).toBe(shot);
  });

  it("leaves a path the sandbox put on the clipboard alone", async () => {
    const dir = await hostDir();
    const shot = join(dir, "shot.png");
    const guest = guestBackend();

    await writeText(shot, PNG);

    const pasteTarget = { ...target(guest.backend), recentCopy: () => `see ${shot} now` };

    expect(await rewrite(shot, pasteTarget)).toBe(shot);
    expect(guest.copies).toEqual([]);
  });

  it("leaves a path the sandbox put on the clipboard in an escaped or quoted spelling alone", async () => {
    const image = async () => ({ data: PNG, extension: "png" });

    await Promise.all(
      ["/Users/me/\\s\\e\\cret.png", "/Users/me/a\\ b.png", '"/Users/me/\\x.png"'].map(async (pasted) => {
        const guest = guestBackend();
        const pasteTarget = { ...target(guest.backend), recentCopy: () => pasted, readImage: image };

        expect(await rewrite(pasted, pasteTarget)).toBe(pasted);
        expect(guest.copies).toEqual([]);
      }),
    );
  });

  it("matches the clipboard across line-ending changes and stripped controls", async () => {
    const image = async () => ({ data: PNG, extension: "png" });

    await Promise.all(
      [
        { copied: "'/w/x\ny.png'", pasted: "'/w/x\ry.png'" },
        { copied: "/w/s\u0000ecret.png", pasted: "/w/secret.png" },
      ].map(async ({ copied, pasted }) => {
        const guest = guestBackend();
        const pasteTarget = { ...target(guest.backend), recentCopy: () => copied, readImage: image };

        expect(await rewrite(pasted, pasteTarget)).toBe(pasted);
        expect(guest.copies).toEqual([]);
      }),
    );
  });

  it("starts no host checks while a timed-out one is still running", async () => {
    vi.useFakeTimers();

    try {
      const guest = guestBackend();
      const stuck: { release?: () => void } = {};
      const reads: string[] = [];
      const pasteTarget = {
        ...target(guest.backend),
        readImage: (path: string) => {
          reads.push(path);

          return reads.length === 1
            ? new Promise<undefined>((resolve) => {
                stuck.release = () => resolve(undefined);
              })
            : Promise.resolve({ data: PNG, extension: "png" });
        },
      };
      const first = rewrite("/stuck/a.png", pasteTarget);

      await vi.advanceTimersByTimeAsync(PASTE_CHECK_TIMEOUT_MS);

      expect(await first).toBe("/stuck/a.png");
      expect(await rewrite("/fine/b.png", pasteTarget)).toBe("/fine/b.png");
      expect(reads).toEqual(["/stuck/a.png"]);

      stuck.release?.();

      await vi.advanceTimersByTimeAsync(0);

      expect(await rewrite("/fine/c.png", pasteTarget)).toMatch(GUEST_PATH);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers the raw paste when the host checks miss the deadline", async () => {
    vi.useFakeTimers();

    try {
      const guest = guestBackend();
      const pasteTarget = {
        ...target(guest.backend),
        readImage: () => new Promise<undefined>(() => undefined),
      };
      const result = rewrite("/stuck/shot.png", pasteTarget);

      await vi.advanceTimersByTimeAsync(PASTE_CHECK_TIMEOUT_MS);

      expect(await result).toBe("/stuck/shot.png");
      expect(guest.copies).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("copies with the bytes on stdin into a fresh file under /tmp/pi-paste", async () => {
    const dir = await hostDir();
    const shot = join(dir, "shot.png");
    const specs: ExecSpec[] = [];
    const backend: PasteTarget["backend"] = {
      exec: async (spec, io) => {
        specs.push(spec);

        await readAll(io.stdin);

        return 0;
      },
    };

    await writeText(shot, PNG);

    await rewrite(shot, target(backend));

    expect(specs[0]).toEqual({
      containerId: "container-1",
      command: [
        "sh",
        "-c",
        `umask 077 && mkdir -p /tmp/pi-paste && set -C && cat > "$1"`,
        "sh",
        expect.stringMatching(GUEST_PATH),
      ],
      env: {},
      workdir: "/",
    });
  });
});

const collect = () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      chunks.push(Buffer.from(chunk));

      done();
    },
  });

  return { stream, text: () => Buffer.concat(chunks).toString() };
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("pasteBridge", () => {
  it("passes keys at once and delivers keys typed during a copy after the rewritten paste", async () => {
    const dir = await hostDir();
    const shot = join(dir, "shot.png");
    const gate: { open: () => void } = { open: () => undefined };
    const guest = guestBackend({
      gate: new Promise<void>((resolve) => {
        gate.open = resolve;
      }),
    });
    const stdin = new PassThrough();
    const bridge = pasteBridge(stdin, target(guest.backend));
    const seen = collect();

    bridge.input.pipe(seen.stream);

    await writeText(shot, PNG);

    stdin.write("ab");

    await settle();

    expect(seen.text()).toBe("ab");

    stdin.write(`\x1b[200~${shot}`);

    stdin.write("\x1b[201~typed");

    stdin.write("more");

    await settle();

    expect(seen.text()).toBe("ab");

    gate.open();

    stdin.end();

    await new Promise((resolve) => bridge.input.once("end", resolve));

    const [before, pasted, after] = seen.text().split(/\[20[01]~/);

    expect(before).toBe("ab\x1b");
    expect(pasted).toMatch(/^\/tmp\/pi-paste\/[0-9a-f-]{36}\.png.$/);
    expect(after).toBe("typedmore");

    bridge.stop();
  });

  it("passes a paste with no image through byte for byte", async () => {
    const stdin = new PassThrough();
    const guest = guestBackend();
    const bridge = pasteBridge(stdin, target(guest.backend));
    const seen = collect();

    bridge.input.pipe(seen.stream);

    stdin.end("\x1b[200~hello /nowhere/x.png\x1b[201~\r");

    await new Promise((resolve) => bridge.input.once("end", resolve));

    expect(seen.text()).toBe("\x1b[200~hello /nowhere/x.png\x1b[201~\r");
    expect(guest.copies).toEqual([]);
  });
});

describe("copyBridge", () => {
  it("sends copies to the host clipboard and the rest to the terminal", async () => {
    const terminal = collect();
    const copied: string[] = [];
    const bridge = copyBridge(terminal.stream, async (text) => {
      copied.push(text.toString());

      return true;
    });
    const sequence = `\x1b]52;c;${Buffer.from("copied").toString("base64")}\x07`;

    bridge.output.write(`a${sequence.slice(0, 7)}`);

    bridge.output.write(`${sequence.slice(7)}b\x1b]52;c;?\x07c`);

    await settle();

    bridge.release();

    expect(terminal.text()).toBe("abc");
    expect(copied).toEqual(["copied"]);
  });

  it("forwards a rebuilt sequence when the clipboard cannot be set", async () => {
    const terminal = collect();
    const bridge = copyBridge(terminal.stream, async () => false);

    bridge.output.write("\x1b]52;c;eA==\x1b\\");

    await settle();

    expect(terminal.text()).toBe("\x1b]52;c;eA==\x07");

    bridge.release();
  });

  it("runs one copy at a time and ends with the newest", async () => {
    const terminal = collect();
    const clipboard: { running: number; most: number; last?: string } = { running: 0, most: 0 };
    const bridge = copyBridge(terminal.stream, async (text) => {
      clipboard.running += 1;
      clipboard.most = Math.max(clipboard.most, clipboard.running);

      await settle();

      clipboard.last = text.toString();
      clipboard.running -= 1;

      return true;
    });
    const burst = Array.from(
      { length: 50 },
      (_, index) => `\x1b]52;c;${Buffer.from(`copy ${index}`).toString("base64")}\x07`,
    );

    bridge.output.write(burst.join(""));

    await Array.from({ length: 10 }).reduce<Promise<void>>(
      (waited) => waited.then(settle),
      Promise.resolve(),
    );

    bridge.release();

    expect(clipboard).toEqual({ running: 0, most: 1, last: "copy 49" });
    expect(bridge.recentCopy()).toBe("copy 49");
  });

  it("drops a partial opener held at the end", async () => {
    const terminal = collect();
    const bridge = copyBridge(terminal.stream, async () => true);

    bridge.output.write("x\x1b]5");

    await settle();

    bridge.release();

    expect(terminal.text()).toBe("x");
  });
});
