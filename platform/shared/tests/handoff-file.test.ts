import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeHandoffFile } from "../handoff/handoff-file.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();

  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
  vi.mocked(writeFileSync).mockClear();
});

const target = () => {
  const root = mkdtempSync(join(tmpdir(), "handoff-file-"));

  roots.push(root);

  return join(root, "session-id", "main-handoff.md");
};

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
