import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecIo } from "../../backend/index.ts";
import type { CliDeps } from "../../cli/deps.ts";
import { run } from "../../cli/index.ts";
import { createFakeBackend, createHarness, isPiSession } from "./harness.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const OSASCRIPT = "/usr/bin/osascript";

const drained = (stream: NodeJS.ReadableStream | undefined) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];

    stream?.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

    stream?.once("end", () => resolve(Buffer.concat(chunks)));
  });

interface ClipboardLaunch {
  platform?: CliDeps["platform"];
  clipboard?: boolean;
  read?: { code: number; stdout: string };
}

const launchWithCtrlV = async (options: ClipboardLaunch = {}) => {
  const typed: { stdin?: NodeJS.WritableStream } = {};
  const piInput: string[] = [];
  const imports: Array<{ path: string; data: Buffer }> = [];
  const fake = createFakeBackend({
    exec: async (spec, io: ExecIo) => {
      if (spec.command[2]?.includes("/tmp/pi-paste") === true) {
        imports.push({ path: spec.command.at(-1) ?? "", data: await drained(io.stdin) });

        return 0;
      }

      if (!isPiSession(spec)) {
        return undefined;
      }

      const input = drained(io.stdin);

      typed.stdin?.end("\x16");

      piInput.push((await input).toString());

      return 0;
    },
  });
  const harness = await createHarness({
    backend: () => fake.backend,
    respond: (call) =>
      call.file === OSASCRIPT
        ? (options.read ?? { code: 0, stdout: `«data PNGf${PNG.toString("hex").toUpperCase()}»\n` })
        : undefined,
  });

  Object.assign(harness.deps.terminal.stdin, { isTTY: true });

  Object.assign(harness.deps.terminal.stdout, { isTTY: true });

  const shown: Buffer[] = [];

  harness.deps.terminal.stdout.on("data", (chunk: Buffer) => shown.push(chunk));

  harness.deps.platform = options.platform ?? "darwin";
  typed.stdin = harness.deps.terminal.stdin as unknown as NodeJS.WritableStream;

  if (options.clipboard !== undefined) {
    await harness.writeJson(harness.userConfigFile, { terminal: { clipboard: options.clipboard } });
  }

  const code = await run([], harness.deps);
  const reads = harness.calls.filter((call) => call.file === OSASCRIPT);

  return { code, reads, imports, piInput: piInput[0], shown: Buffer.concat(shown).toString() };
};

describe("Ctrl+V image paste at launch", () => {
  it("reads the clipboard PNG through osascript with a timeout and pastes its sandbox path", async () => {
    const launched = await launchWithCtrlV();

    expect(launched.code).toBe(0);
    expect(launched.reads[0]?.args.at(-1)).toBe("the clipboard as «class PNGf»");
    expect(launched.reads[0]?.options.timeoutMs).toBeGreaterThan(0);
    expect(launched.imports).toEqual([
      { path: expect.stringMatching(/^\/tmp\/pi-paste\/[0-9a-f-]{36}\.png$/), data: PNG },
    ]);
    expect(launched.piInput).toBe(`\x1b[200~${launched.imports[0]?.path}\x1b[201~`);
  });

  it("forwards Ctrl+V when the clipboard holds no PNG", async () => {
    const launched = await launchWithCtrlV({ read: { code: 1, stdout: "" } });

    expect(launched.piInput).toBe("\x16");
    expect(launched.imports).toEqual([]);
  });

  it("imports a single copied image file", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "pinata-ctrlv-")));
    const file = join(dir, "copied shot.png");

    await writeFile(file, PNG);

    const launched = await launchWithCtrlV({ read: { code: 0, stdout: `${file}\n` } });

    await rm(dir, { recursive: true, force: true });

    expect(launched.imports).toEqual([
      { path: expect.stringMatching(/^\/tmp\/pi-paste\/[0-9a-f-]{36}\.png$/), data: PNG },
    ]);
    expect(launched.piInput).toBe(`\x1b[200~${launched.imports[0]?.path}\x1b[201~`);
  });

  it("forwards Ctrl+V without a notice when the script refuses several copied files", async () => {
    const launched = await launchWithCtrlV({ read: { code: 1, stdout: "" } });

    expect(launched.reads[0]?.args).toContain('if (count of refs) > 1 then error "files"');
    expect(launched.piInput).toBe("\x16");
    expect(launched.imports).toEqual([]);
    expect(launched.shown).not.toContain("\x1b]9;");
  });

  it("never reads the clipboard off macOS or with terminal.clipboard off", async () => {
    const linux = await launchWithCtrlV({ platform: "linux" });
    const off = await launchWithCtrlV({ clipboard: false });

    expect([linux.reads, off.reads]).toEqual([[], []]);
    expect([linux.piInput, off.piInput]).toEqual(["\x16", "\x16"]);
  });
});
