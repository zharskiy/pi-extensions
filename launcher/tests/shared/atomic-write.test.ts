import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LauncherError, writeFileAtomic } from "../../shared/index.ts";

const state = { dir: "" };

beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "pi-sandbox-atomic-"));
});

afterEach(async () => {
  await rm(state.dir, { recursive: true, force: true });
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
