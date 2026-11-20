import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { writeHandoffFile } from "../handoff/handoff-file.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();

  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

const temp = useTempDirs();

afterEach(() => {
  vi.mocked(writeFileSync).mockClear();
});

const target = () => join(temp.make("handoff-file-"), "session-id", "main-handoff.md");

describe("writeHandoffFile", () => {
  it("creates the folder and writes the file", () => {
    const path = target();

    writeHandoffFile(path, "text\n");

    expect(readFileSync(path, "utf8")).toBe("text\n");
  });

  it("writes again when the folder vanishes between the mkdir and the write", async () => {
    const path = target();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");

    vi.mocked(writeFileSync).mockImplementationOnce((file, data) => {
      rmSync(dirname(String(file)), { recursive: true });
      actual.writeFileSync(file, data);
    });

    writeHandoffFile(path, "text\n");

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(2);
    expect(readFileSync(path, "utf8")).toBe("text\n");
  });
});
