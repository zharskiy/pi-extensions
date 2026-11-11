import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isJsonObject,
  LauncherError,
  parseJsonObject,
  readJsonFile,
  readJsonObject,
  writeJsonFile,
} from "../../shared/index.ts";
import { tempDir as sharedTempDir } from "../support/temp-dir.ts";

const tempDir = () => sharedTempDir("json");

describe("readJsonFile", () => {
  it("returns undefined when the file is missing", async () => {
    expect(await readJsonFile(join(await tempDir(), "missing.json"))).toBeUndefined();
  });

  it("parses the file", async () => {
    const path = join(await tempDir(), "config.json");

    await writeFile(path, '{"backend":"colima"}');

    expect(await readJsonFile<{ backend: string }>(path)).toEqual({ backend: "colima" });
  });

  it("throws a LauncherError naming the file on invalid JSON", async () => {
    const path = join(await tempDir(), "broken.json");

    await writeFile(path, "{");

    const result = readJsonFile(path);

    await expect(result).rejects.toBeInstanceOf(LauncherError);
    await expect(result).rejects.toThrow(`${path}: invalid JSON`);
  });

  it("throws a LauncherError when the path cannot be read", async () => {
    await expect(readJsonFile(await tempDir())).rejects.toBeInstanceOf(LauncherError);
  });
});

describe("writeJsonFile", () => {
  it("creates missing folders and writes formatted JSON with a trailing newline", async () => {
    const path = join(await tempDir(), "nested", "deeper", "state.json");

    await writeJsonFile(path, { ports: [3000] });

    expect(await readFile(path, "utf8")).toBe('{\n  "ports": [\n    3000\n  ]\n}\n');
  });

  it("replaces an existing file and leaves no temporary file behind", async () => {
    const dir = await tempDir();
    const path = join(dir, "state.json");

    await writeJsonFile(path, { version: 1 });

    await writeJsonFile(path, { version: 2 });

    expect(await readJsonFile(path)).toEqual({ version: 2 });
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  it("applies the requested file mode", async () => {
    const path = join(await tempDir(), "secret.json");

    await writeJsonFile(path, {}, { mode: 0o600 });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("throws a LauncherError and cleans up when the target cannot be replaced", async () => {
    const dir = await tempDir();

    await writeJsonFile(join(dir, "taken", "inner.json"), {});

    await expect(writeJsonFile(join(dir, "taken"), {})).rejects.toBeInstanceOf(LauncherError);
    expect((await readdir(dir)).sort()).toEqual(["taken"]);
  });
});

describe("lenient JSON objects", () => {
  it("accepts only plain objects", () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject("text")).toBe(false);
  });

  it("parses an object and answers undefined for anything else", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject("[1]")).toBeUndefined();
    expect(parseJsonObject("{ not json")).toBeUndefined();
  });

  it("reads an object file and answers undefined when it is missing, invalid or not an object", async () => {
    const dir = await tempDir();

    await writeFile(join(dir, "good.json"), '{"a":1}');

    await writeFile(join(dir, "bad.json"), "{ not json");

    await writeFile(join(dir, "list.json"), "[1]");

    expect(await readJsonObject(join(dir, "good.json"))).toEqual({ a: 1 });
    expect(await readJsonObject(join(dir, "bad.json"))).toBeUndefined();
    expect(await readJsonObject(join(dir, "list.json"))).toBeUndefined();
    expect(await readJsonObject(join(dir, "missing.json"))).toBeUndefined();
    expect(await readJsonObject(dir)).toBeUndefined();
  });
});
