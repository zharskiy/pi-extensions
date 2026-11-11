import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureRandomHexFile, LauncherError, writeFileAtomic } from "../../shared/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const state = { dir: "" };

beforeEach(async () => {
  state.dir = await tempDir("atomic");
});

describe("writeFileAtomic", () => {
  it("creates missing folders and writes the content", async () => {
    const path = join(state.dir, "a", "b", "file.txt");

    await writeFileAtomic(path, "hello");

    expect(await readFile(path, "utf8")).toBe("hello");
  });

  it("replaces an existing file, applies the mode and leaves no temp file", async () => {
    const path = join(state.dir, "secret.json");

    await writeFile(path, "old", { mode: 0o644 });

    await writeFileAtomic(path, Buffer.from("new"), { mode: 0o600 });

    expect(await readFile(path, "utf8")).toBe("new");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(state.dir)).toEqual(["secret.json"]);
  });

  it("reports a failure as a LauncherError naming the path and cleans up", async () => {
    const blocker = join(state.dir, "file");

    await writeFile(blocker, "");

    await expect(writeFileAtomic(join(blocker, "child"), "x")).rejects.toBeInstanceOf(LauncherError);
    expect(await readdir(state.dir)).toEqual(["file"]);
  });
});

describe("ensureRandomHexFile", () => {
  it("gives every concurrent caller the one value it writes, mode 600, and leaves no temp file", async () => {
    const path = join(state.dir, "keys", "salt");
    const values = await Promise.all(Array.from({ length: 16 }, () => ensureRandomHexFile(path, 32)));

    expect(new Set(values).size).toBe(1);
    expect(values[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(path, "utf8")).toBe(values[0]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(state.dir, "keys"))).toEqual(["salt"]);
  });

  it("keeps a valid file and replaces one that does not hold the expected hex", async () => {
    const path = join(state.dir, "token");

    await writeFile(path, "ab".repeat(16));

    expect(await ensureRandomHexFile(path, 16)).toBe("ab".repeat(16));

    await writeFile(path, "");

    const replaced = await ensureRandomHexFile(path, 16);

    expect(replaced).toMatch(/^[0-9a-f]{32}$/);
    expect(await readFile(path, "utf8")).toBe(replaced);
  });
});
