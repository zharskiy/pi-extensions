import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverGitOverlay } from "../../container/index.ts";
import { createFakeRunner } from "../support/fake-runner.ts";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const touch = async (path: string) => {
  await mkdir(join(path, ".."), { recursive: true });

  await writeFile(path, "");
};

const createRepo = async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-git-")));
  const repoRoot = join(base, "repo");
  const gitDir = join(repoRoot, ".git");

  created.push(base);

  await mkdir(join(gitDir, "hooks"), { recursive: true });
  await mkdir(join(repoRoot, ".githooks"), { recursive: true });
  await mkdir(join(base, "outside-hooks"), { recursive: true });
  await mkdir(join(gitDir, "modules", "lib", "hooks"), { recursive: true });
  await touch(join(gitDir, "config"));
  await touch(join(gitDir, "modules", "lib", "HEAD"));
  await touch(join(gitDir, "modules", "lib", "config"));
  await touch(join(gitDir, "modules", "lib", "modules", "nested", "HEAD"));
  await touch(join(gitDir, "modules", "lib", "modules", "nested", "config"));
  await touch(join(gitDir, "modules", "lib", "objects", "pack", "HEAD"));
  await touch(join(gitDir, "modules", "lib", "objects", "pack", "config"));
  await touch(join(gitDir, "worktrees", "wt", "config.worktree"));
  await mkdir(join(gitDir, "worktrees", "bare"), { recursive: true });

  return {
    base,
    repoRoot,
    gitDir,
    workspace: { cwd: repoRoot, repoRoot, gitCommonDir: gitDir, isGitRepo: true },
  };
};

const hooksPathRunner = (value: string | undefined) =>
  createFakeRunner((call) =>
    call.args.join(" ") === "config --get core.hooksPath"
      ? { code: value === undefined ? 1 : 0, stdout: value === undefined ? "" : `${value}\n` }
      : undefined,
  ).runner;

describe("discoverGitOverlay", () => {
  it("finds the hooks path, submodule hooks and configs and worktree configs that exist", async () => {
    const { repoRoot, gitDir, workspace, base } = await createRepo();
    const overlay = await discoverGitOverlay(workspace, hooksPathRunner(".githooks"), base);

    expect(overlay.dirs.sort()).toEqual(
      [
        join(gitDir, "hooks"),
        join(repoRoot, ".githooks"),
        join(gitDir, "modules", "lib", "hooks"),
        join(gitDir, "modules", "lib", "modules", "nested", "hooks"),
      ].sort(),
    );
    expect(overlay.files.sort()).toEqual(
      [
        join(gitDir, "modules", "lib", "config"),
        join(gitDir, "modules", "lib", "modules", "nested", "config"),
        join(gitDir, "worktrees", "wt", "config.worktree"),
      ].sort(),
    );
  });

  it("creates missing hook directories, a configured hooks path and submodule hooks, so they mount read-only", async () => {
    const { repoRoot, gitDir, workspace, base } = await createRepo();

    await rm(join(gitDir, "hooks"), { recursive: true });

    const overlay = await discoverGitOverlay(workspace, hooksPathRunner("tools/hooks"), base);
    const wanted = [
      join(gitDir, "hooks"),
      join(repoRoot, "tools", "hooks"),
      join(gitDir, "modules", "lib", "modules", "nested", "hooks"),
    ];

    expect(overlay.dirs).toEqual(expect.arrayContaining(wanted));
    expect(await Promise.all(wanted.map(async (dir) => (await stat(dir)).isDirectory()))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("walks only module git dirs, not their objects", async () => {
    const { gitDir, workspace, base } = await createRepo();
    const overlay = await discoverGitOverlay(workspace, hooksPathRunner(undefined), base);

    expect(overlay.files.some((file) => file.includes("objects"))).toBe(false);
    expect(overlay.dirs.some((dir) => dir.includes("objects"))).toBe(false);
    expect(overlay.files).toContain(join(gitDir, "modules", "lib", "modules", "nested", "config"));
  });

  it("leaves out a hooks path outside the mounted repository, which the container cannot see", async () => {
    const { workspace, base } = await createRepo();
    const overlay = await discoverGitOverlay(workspace, hooksPathRunner(join(base, "outside-hooks")), base);
    const missing = await discoverGitOverlay(workspace, hooksPathRunner(join(base, "absent-hooks")), base);

    expect(overlay.dirs.some((dir) => dir.includes("outside-hooks"))).toBe(false);
    expect(missing.dirs.some((dir) => dir.includes("absent-hooks"))).toBe(false);
    expect(await stat(join(base, "absent-hooks")).catch(() => undefined)).toBeUndefined();
  });

  it("finds nothing outside git and tolerates a failing git", async () => {
    const { workspace, base } = await createRepo();
    const failing = createFakeRunner(() => undefined).runner;

    expect(await discoverGitOverlay({ ...workspace, gitCommonDir: undefined }, failing, base)).toEqual({
      dirs: [],
      files: [],
    });
    expect((await discoverGitOverlay(workspace, failing, base)).dirs).not.toContain(
      join(workspace.repoRoot, ".githooks"),
    );
  });
});
