import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { ExecIo } from "../../backend/index.ts";
import type { CliDeps } from "../../cli/deps.ts";
import { run } from "../../cli/index.ts";
import { PASTE_IMAGE_MAX_BYTES } from "../../container/index.ts";
import { createFakeBackend, createHarness, isPiSession } from "./harness.ts";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8, 3),
]);

const OSASCRIPT = "/usr/bin/osascript";

const drained = (stream: NodeJS.ReadableStream | undefined) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];

    stream?.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

    stream?.once("end", () => resolve(Buffer.concat(chunks).toString()));
  });

interface ClipboardLaunch {
  platform?: CliDeps["platform"];
  clipboard?: boolean;
  stdout?: string;
}

const launchWithCtrlV = async (options: ClipboardLaunch = {}) => {
  const typed: { stdin?: NodeJS.WritableStream } = {};
  const piInput: string[] = [];
  const copies: string[] = [];
  const fake = createFakeBackend({
    exec: async (spec, io: ExecIo) => {
      if (spec.command[2]?.includes("/tmp/pi-paste") === true) {
        copies.push(spec.command.at(-1) ?? "");

        await drained(io.stdin);

        return 0;
      }

      if (!isPiSession(spec)) {
        return undefined;
      }

      const input = drained(io.stdin);

      typed.stdin?.end("\x16");

      piInput.push(await input);

      return 0;
    },
  });
  const harness = await createHarness({
    backend: () => fake.backend,
    respond: (call) =>
      call.file === OSASCRIPT ? { stdout: `${options.stdout ?? PNG.toString("base64")}\n` } : undefined,
  });

  Object.assign(harness.deps.terminal.stdin, { isTTY: true });

  Object.assign(harness.deps.terminal.stdout, { isTTY: true });

  harness.deps.platform = options.platform ?? "darwin";
  typed.stdin = harness.deps.terminal.stdin as unknown as NodeJS.WritableStream;

  if (options.clipboard !== undefined) {
    await harness.writeJson(harness.userConfigFile, { terminal: { clipboard: options.clipboard } });
  }

  const code = await run([], harness.deps);
  const reads = harness.calls.filter((call) => call.file === OSASCRIPT);

  return { code, reads, copies, piInput: piInput[0] };
};

describe("Ctrl+V image paste at launch", () => {
  it("reads the clipboard image through osascript with a timeout and pastes its sandbox path", async () => {
    const launched = await launchWithCtrlV();

    expect(launched.code).toBe(0);
    expect(launched.reads.map((call) => call.args.slice(0, 3))).toEqual([["-l", "JavaScript", "-e"]]);
    expect(launched.reads[0]?.options.timeoutMs).toBeGreaterThan(0);
    expect(launched.reads[0]?.args[3]).toContain("NSPasteboard");
    expect(launched.copies).toEqual([expect.stringMatching(/^\/tmp\/pi-paste\/[0-9a-f-]{36}\.png$/)]);
    expect(launched.piInput).toBe(`\x1b[200~${launched.copies[0]}\x1b[201~`);
  });

  it("forwards Ctrl+V when osascript prints nothing or something that is not base64", async () => {
    const empty = await launchWithCtrlV({ stdout: "" });
    const garbage = await launchWithCtrlV({ stdout: "not base64!" });

    expect([empty.piInput, garbage.piInput]).toEqual(["\x16", "\x16"]);
    expect([...empty.copies, ...garbage.copies]).toEqual([]);
  });

  it("never reads the clipboard off macOS or with terminal.clipboard off", async () => {
    const linux = await launchWithCtrlV({ platform: "linux" });
    const off = await launchWithCtrlV({ clipboard: false });

    expect([linux.reads, off.reads]).toEqual([[], []]);
    expect([linux.piInput, off.piInput]).toEqual(["\x16", "\x16"]);
  });

  it("takes PNG, JPEG or TIFF as PNG, and reads nothing for text, a file copy or a file icon", async () => {
    const script = (await launchWithCtrlV()).reads[0]?.args[3] ?? "";
    const pasteboard = (types: string[], length = 16) => {
      const reads: string[] = [];
      const data = (name: string) => ({
        length,
        isNil: () => false,
        base64EncodedStringWithOptions: () => ({ js: name }),
      });
      const board = {
        types,
        dataForType: (type: string) => {
          reads.push(type);

          return data(type);
        },
      };
      const bridge = Object.assign(() => ({}), {
        NSPasteboard: { generalPasteboard: board },
        NSBitmapImageFileTypePNG: 4,
        NSBitmapImageRep: {
          imageRepWithData: () => ({
            isNil: () => false,
            representationUsingTypeProperties: () => data("tiff as png"),
          }),
        },
      });
      const printed = runInNewContext(script, {
        ObjC: { import: () => undefined, deepUnwrap: (value: unknown) => value },
        $: bridge,
      });

      return { printed, reads };
    };

    expect(pasteboard(["public.tiff", "public.png", "public.jpeg"])).toEqual({
      printed: "public.png",
      reads: ["public.png"],
    });
    expect(pasteboard(["public.jpeg", "public.tiff"]).printed).toBe("public.jpeg");
    expect(pasteboard(["public.tiff"])).toEqual({ printed: "tiff as png", reads: ["public.tiff"] });
    expect(pasteboard(["public.png"], PASTE_IMAGE_MAX_BYTES + 1).printed).toBe("");
    [
      ["public.utf8-plain-text"],
      ["public.file-url", "public.utf8-plain-text", "com.apple.icns", "public.tiff"],
      ["NSFilenamesPboardType", "public.png"],
      ["public.file-url", "public.png"],
      ["com.apple.icns", "public.tiff"],
      [],
    ].forEach((types) => {
      expect(pasteboard(types)).toEqual({ printed: "", reads: [] });
    });
  });
});
