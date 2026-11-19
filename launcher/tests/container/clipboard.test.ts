import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Backend, ExecIo, ExecSpec, MountSpec } from "../../backend/index.ts";
import { copyTee, pasteBridge } from "../../container/clipboard.ts";

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

describe("pasteBridge", () => {
  const root: { dir: string } = { dir: "" };

  beforeAll(async () => {
    root.dir = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-paste-")));

    await writeFile(join(root.dir, "my shot.png"), PNG);

    await writeFile(join(root.dir, "notes.txt"), "text");
  });

  afterAll(() => rm(root.dir, { recursive: true, force: true }));

  const bridged = async (chunks: string[], options: { image?: Buffer; mounts?: MountSpec[] } = {}) => {
    const imports: Array<{ path: string; data: Buffer }> = [];
    const backend: Pick<Backend, "exec"> = {
      exec: async (spec: ExecSpec, io: ExecIo) => {
        const data = await new Promise<Buffer>((resolve) => {
          const parts: Buffer[] = [];

          io.stdin?.on("data", (part: Buffer) => parts.push(part));

          io.stdin?.once("end", () => resolve(Buffer.concat(parts)));
        });

        imports.push({ path: spec.command.at(-1) ?? "", data });

        return 0;
      },
    };
    const stdin = new PassThrough();
    const reads: number[] = [];
    const { input } = pasteBridge(
      stdin,
      { backend, containerId: "c" },
      {
        copy: async () => undefined,
        readImage: async () => {
          reads.push(1);

          return options.image;
        },
        mounts: options.mounts ?? [],
      },
    );
    const received: Buffer[] = [];

    input.on("data", (chunk: Buffer) => received.push(chunk));

    const ended = new Promise((resolve) => input.once("end", resolve));

    chunks.forEach((chunk) => {
      stdin.write(chunk);
    });

    stdin.end();

    await ended;

    return { text: Buffer.concat(received).toString(), imports, reads: reads.length };
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

  it("forwards other pastes unchanged", async () => {
    const chunks = [
      paste(join(root.dir, "notes.txt")),
      paste(join(root.dir, "missing.png")),
      paste(`see ${join(root.dir, "my shot.png")}`),
    ];
    const run = await bridged(chunks);

    expect(run.text).toBe(chunks.join(""));
    expect(run.imports).toEqual([]);
  });

  it("forwards a path the sandbox already sees", async () => {
    const chunk = paste(join(root.dir, "my\\ shot.png"));
    const mounts: MountSpec[] = [{ kind: "bind", source: root.dir, target: root.dir, readOnly: true }];
    const run = await bridged([chunk], { mounts });

    expect(run.text).toBe(chunk);
  });

  it("pastes the clipboard image on Ctrl+V, including a non-Latin layout", async () => {
    const run = await bridged(["\x16", "\x1b[1084::118;5u", "x"], { image: PNG });

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
