import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Backend, ExecIo, ExecSpec, MountSpec } from "../../backend/index.ts";
import { type ClipboardContent, copyTee, pasteBridge } from "../../container/clipboard.ts";

const readFailures = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    readFile: (path: string) => {
      const code = readFailures.get(path);

      return code === undefined
        ? actual.readFile(path)
        : Promise.reject(Object.assign(new Error(code), { code }));
    },
  };
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const GUEST = /^\/tmp\/pi-paste\/[0-9a-f-]{36}\.png$/;

const osc52 = (text: string, end = "\x07") => `\x1b]52;c;${Buffer.from(text).toString("base64")}${end}`;

const teed = async (chunks: string[]) => {
  const terminal = new PassThrough();
  const copied: string[] = [];
  const output: Buffer[] = [];

  terminal.on("data", (chunk: Buffer) => output.push(chunk));

  const tee = copyTee(terminal, async (text) => copied.push(text.toString()));

  chunks.forEach((chunk) => {
    tee.write(Buffer.from(chunk, "latin1"));
  });

  await new Promise((resolve) => setImmediate(resolve));

  return { output: Buffer.concat(output).toString("latin1"), copied };
};

describe("copyTee", () => {
  it("forwards output unchanged and copies each OSC 52 write", async () => {
    const output = `a${osc52("one")}b${osc52("två", "\x1b\\")}c`;
    const run = await teed([output]);

    expect(run.output).toBe(output);
    expect(run.copied).toEqual(["one", "två"]);
  });

  it("copies a write split across chunks", async () => {
    const sequence = osc52("split");
    const run = await teed(["x\x1b]5", sequence.slice(3, 12), `${sequence.slice(12)}y`]);

    expect(run.output).toBe(`x${sequence}y`);
    expect(run.copied).toEqual(["split"]);
  });

  it("ignores queries and malformed writes", async () => {
    const run = await teed(["\x1b]52;c;?\x07", "\x1b]52;c;not base64!\x07"]);

    expect(run.copied).toEqual([]);
  });
});

describe("copyTee notices", () => {
  const notified = async (chunks: string[], notice: number) => {
    const terminal = new PassThrough();
    const output: Buffer[] = [];

    terminal.on("data", (chunk: Buffer) => output.push(chunk));

    const tee = copyTee(terminal, async () => undefined);

    chunks.forEach((chunk, index) => {
      if (index === notice) {
        tee.notify("note");
      }

      tee.write(Buffer.from(chunk, "latin1"));
    });

    await new Promise((resolve) => setImmediate(resolve));

    return Buffer.concat(output).toString("latin1");
  };

  const NOTE = "\x1b]9;note\x07";

  it("writes a notice at once between whole output chunks", async () => {
    expect(await notified(["\x1b[31mred\x1b[0m", "next"], 1)).toBe(`\x1b[31mred\x1b[0m${NOTE}next`);
  });

  it("holds a notice until a split escape sequence or character is complete", async () => {
    const cases = [
      ["a\x1b[3", "8;5;1mb", "c"],
      ["a\x1b]0;ti", "tle", "\x07b", "c"],
      ["a\x1b]0;title\x1b", "\\b", "c"],
      ["a\x1b", "(Bb", "c"],
      ["a\xc3", "\xa9b", "c"],
      ["a\xe2\x86", "\x92b", "c"],
    ];
    const outputs = await Promise.all(cases.map((chunks) => notified(chunks, 1)));

    expect(outputs).toEqual(cases.map((chunks) => `${chunks.slice(0, -1).join("")}${NOTE}c`));
  });
});

describe("pasteBridge", () => {
  const root: { dir: string } = { dir: "" };

  beforeAll(async () => {
    root.dir = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-paste-")));

    await writeFile(join(root.dir, "my shot.png"), PNG);

    await writeFile(join(root.dir, "notes.txt"), "text");

    await writeFile(join(root.dir, "denied.png"), PNG);

    await mkdir(join(root.dir, "folder.png"));

    readFailures.set(join(root.dir, "denied.png"), "EPERM");
  });

  afterAll(() => rm(root.dir, { recursive: true, force: true }));

  const bridged = async (
    chunks: string[],
    options: { content?: ClipboardContent; mounts?: MountSpec[]; copyFails?: boolean } = {},
  ) => {
    const imports: Array<{ path: string; data: Buffer }> = [];
    const backend: Pick<Backend, "exec"> = {
      exec: async (spec: ExecSpec, io: ExecIo) => {
        const data = await new Promise<Buffer>((resolve) => {
          const parts: Buffer[] = [];

          io.stdin?.on("data", (part: Buffer) => parts.push(part));

          io.stdin?.once("end", () => resolve(Buffer.concat(parts)));
        });

        imports.push({ path: spec.command.at(-1) ?? "", data });

        if (options.copyFails === true) {
          throw new Error("exec failed");
        }

        return 0;
      },
    };
    const stdin = new PassThrough();
    const notices: string[] = [];
    const reads: number[] = [];

    const { input } = pasteBridge(
      stdin,
      { backend, containerId: "c" },
      {
        copy: async () => undefined,
        read: async () => {
          reads.push(1);

          return options.content;
        },
        mounts: options.mounts ?? [],
      },
      (notice) => notices.push(notice),
    );
    const received: Buffer[] = [];

    input.on("data", (chunk: Buffer) => received.push(chunk));

    const ended = new Promise((resolve) => input.once("end", resolve));

    chunks.forEach((chunk) => {
      stdin.write(chunk);
    });

    stdin.end();

    await ended;

    return { text: Buffer.concat(received).toString(), imports, reads: reads.length, notices };
  };

  const paste = (body: string) => `\x1b[200~${body}\x1b[201~`;

  it("copies a pasted host image into the sandbox and pastes its sandbox path", async () => {
    const escaped = join(root.dir, "my shot.png").replaceAll(" ", "\\ ");
    const run = await bridged([paste(`${escaped} `), "after"]);

    expect(run.imports).toEqual([{ path: expect.stringMatching(GUEST), data: PNG }]);
    expect(run.text).toBe(`${paste(`${run.imports[0]?.path} `)}after`);
  });

  it("takes a quoted path", async () => {
    const run = await bridged([paste(`'${join(root.dir, "my shot.png")}'\n`)]);

    expect(run.imports).toHaveLength(1);
  });

  it("forwards other pastes unchanged and silently", async () => {
    const chunks = [
      paste(join(root.dir, "notes.txt")),
      paste(join(root.dir, "missing.txt")),
      paste(`see ${join(root.dir, "my shot.png")}`),
      paste(`${join(root.dir, "my\\ shot.png")} ${join(root.dir, "denied.png")} `),
      paste(`'${join(root.dir, "my shot.png")}' '${join(root.dir, "denied.png")}'`),
      paste(`"${join(root.dir, "my shot.png")}" "${join(root.dir, "missing.png")}"`),
    ];
    const run = await bridged(chunks);

    expect(run.text).toBe(chunks.join(""));
    expect(run.imports).toEqual([]);
    expect(run.notices).toEqual([]);
  });

  it("forwards a path the sandbox already sees, silently", async () => {
    const chunks = [paste(join(root.dir, "my\\ shot.png")), paste(join(root.dir, "missing.png"))];
    const mounts: MountSpec[] = [{ kind: "bind", source: root.dir, target: root.dir, readOnly: true }];
    const run = await bridged(chunks, { mounts });

    expect(run.text).toBe(chunks.join(""));
    expect(run.notices).toEqual([]);
  });

  it("forwards a failed image import with a notice saying why", async () => {
    const chunks = [
      paste(`${join(root.dir, "denied.png")} `),
      paste(join(root.dir, "missing.png")),
      paste(join(root.dir, "folder.png")),
      "after",
    ];
    const run = await bridged(chunks);

    expect(run.text).toBe(chunks.join(""));
    expect(run.notices).toEqual([
      "pinata: image not copied into the sandbox: macOS blocked the terminal from reading it; allow access in System Settings → Privacy & Security → Files and Folders",
      "pinata: image not copied into the sandbox: there is no such file on the host",
      "pinata: image not copied into the sandbox: it is not a regular file",
    ]);
  });

  it("forwards the paste with a notice when the copy into the container throws", async () => {
    const chunks = [paste(join(root.dir, "my\\ shot.png")), "after"];
    const run = await bridged(chunks, { copyFails: true });

    expect(run.text).toBe(chunks.join(""));
    expect(run.notices).toEqual([
      "pinata: image not copied into the sandbox: the copy into the container failed",
    ]);
  });

  it("forwards input when the clipboard read throws", async () => {
    const stdin = new PassThrough();
    const { input } = pasteBridge(
      stdin,
      { backend: { exec: async () => 0 }, containerId: "c" },
      {
        copy: async () => undefined,
        read: () => Promise.reject(new Error("osascript failed")),
        mounts: [],
      },
      () => undefined,
    );
    const received: Buffer[] = [];

    input.on("data", (chunk: Buffer) => received.push(chunk));

    const ended = new Promise((resolve) => input.once("end", resolve));

    stdin.end("\x16");

    await ended;

    expect(Buffer.concat(received).toString()).toBe("\x16");
  });

  it("imports a single image file reference on Ctrl+V like a dropped path", async () => {
    const imported = await bridged(["\x16"], { content: { file: join(root.dir, "my shot.png") } });
    const denied = await bridged(["\x16"], { content: { file: join(root.dir, "denied.png") } });

    expect(imported.imports).toEqual([{ path: expect.stringMatching(GUEST), data: PNG }]);
    expect(imported.text).toBe(paste(imported.imports[0]?.path ?? ""));
    expect(denied.text).toBe("\x16");
    expect(denied.notices).toHaveLength(1);
  });

  it("pastes a file reference the sandbox already sees as its own path", async () => {
    const file = join(root.dir, "my shot.png");
    const mounts: MountSpec[] = [{ kind: "bind", source: root.dir, target: root.dir, readOnly: true }];
    const run = await bridged(["\x16"], { content: { file }, mounts });

    expect(run.text).toBe(paste(file));
    expect(run.imports).toEqual([]);
  });

  it("forwards Ctrl+V silently for a visible file reference whose path holds control characters", async () => {
    const mounts: MountSpec[] = [{ kind: "bind", source: root.dir, target: root.dir, readOnly: true }];
    const runs = await Promise.all(
      ["x\x1b[201~\r!cmd\r.png", "tab\there.png", "del\x7f.png", "c1\x9b.png"].map((name) =>
        bridged(["\x16"], { content: { file: join(root.dir, name) }, mounts }),
      ),
    );

    expect(runs.map((run) => [run.text, run.notices])).toEqual(runs.map(() => ["\x16", []]));
  });

  it("forwards Ctrl+V silently for a non-image file reference", async () => {
    const run = await bridged(["\x16"], { content: { file: join(root.dir, "notes.txt") } });

    expect(run.text).toBe("\x16");
    expect(run.imports).toEqual([]);
    expect(run.notices).toEqual([]);
  });

  it("pastes the clipboard image on Ctrl+V, including a non-Latin layout", async () => {
    const run = await bridged(["\x16", "\x1b[1084::118;5u", "x"], { content: { image: PNG } });

    expect(run.imports.map((entry) => entry.path)).toEqual([
      expect.stringMatching(GUEST),
      expect.stringMatching(GUEST),
    ]);
    expect(run.text).toBe(`${paste(run.imports[0]?.path ?? "")}${paste(run.imports[1]?.path ?? "")}x`);
  });

  it("forwards Ctrl+V without a clipboard image, and a key release without reading", async () => {
    const run = await bridged(["\x1b[118;5u", "\x1b[118;5:3u"]);

    expect(run.text).toBe("\x1b[118;5u\x1b[118;5:3u");
    expect(run.reads).toBe(1);
  });
});
