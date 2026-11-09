import { mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeCreatedDirs } from "../../workspace/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("removeCreatedDirs", () => {
  it("removes recorded dirs deepest first while they are empty and keeps what holds files or is a link", async () => {
    const root = await tempDir("created-dirs");
    const deep = join(root, "a", "b", "c");
    const full = join(root, "full");
    const target = join(root, "target");
    const link = join(root, "link");

    await mkdir(deep, { recursive: true });
    await mkdir(full);
    await writeFile(join(full, "kept.txt"), "kept\n");
    await mkdir(target);
    await symlink(target, link);

    const kept = await removeCreatedDirs([
      join(root, "a"),
      join(root, "a", "b"),
      deep,
      full,
      link,
      join(root, "gone"),
    ]);

    expect(kept).toEqual([]);
    expect(await exists(join(root, "a"))).toBe(false);
    expect(await exists(full)).toBe(true);
    expect(await exists(target)).toBe(true);
    expect(await exists(link)).toBe(true);
  });
});
