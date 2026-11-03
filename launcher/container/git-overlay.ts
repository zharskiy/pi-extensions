import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type CommandRunner, expandHome, isWithin } from "../shared/index.ts";
import type { Workspace } from "../workspace/index.ts";

export interface GitOverlay {
  dirs: string[];
  files: string[];
}

const EMPTY: GitOverlay = { dirs: [], files: [] };

const kindOf = (path: string) =>
  stat(path).then(
    (info) => (info.isDirectory() ? "dir" : "file"),
    () => undefined,
  );

const childDirs = (dir: string) =>
  readdir(dir, { withFileTypes: true }).then(
    (found) => found.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name)),
    () => [],
  );

const existing = async (paths: string[], kind: "dir" | "file") => {
  const kinds = await Promise.all(paths.map(kindOf));

  return paths.filter((_, index) => kinds[index] === kind);
};

const realOrPending = (path: string): Promise<string> =>
  realpath(path).catch(() => {
    const parent = dirname(path);

    return parent === path ? path : realOrPending(parent).then((real) => join(real, basename(path)));
  });

const hooksPath = async (workspace: Workspace, runner: CommandRunner, home: string) => {
  const result = await runner
    .run("git", ["config", "--get", "core.hooksPath"], { cwd: workspace.cwd })
    .catch(() => undefined);
  const value = result?.code === 0 ? result.stdout.trim() : "";

  if (value === "") {
    return [];
  }

  const path = await realOrPending(resolve(workspace.repoRoot, expandHome(value, home)));
  const mounted = [workspace.repoRoot, workspace.gitCommonDir].filter((root) => root !== undefined);

  return mounted.some((root) => isWithin(path, root)) ? [path] : [];
};

const isGitDir = async (dir: string) => (await kindOf(join(dir, "HEAD"))) === "file";

const moduleGitDirs = async (modulesDir: string): Promise<string[]> => {
  const dirs = await childDirs(modulesDir);
  const found = await Promise.all(
    dirs.map(async (dir) =>
      (await isGitDir(dir)) ? [dir, ...(await moduleGitDirs(join(dir, "modules")))] : moduleGitDirs(dir),
    ),
  );

  return found.flat();
};

const worktreeConfigs = async (gitCommonDir: string) => {
  const worktrees = await childDirs(join(gitCommonDir, "worktrees"));

  return [join(gitCommonDir, "config.worktree"), ...worktrees.map((dir) => join(dir, "config.worktree"))];
};

const ensureDirs = async (paths: string[]) => {
  await Promise.all(paths.map((path) => mkdir(path, { recursive: true }).catch(() => undefined)));

  return existing(paths, "dir");
};

export const discoverGitOverlay = async (
  workspace: Workspace,
  runner: CommandRunner,
  home: string,
): Promise<GitOverlay> => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return EMPTY;
  }

  const modules = await moduleGitDirs(join(gitCommonDir, "modules"));
  const hooks = await hooksPath(workspace, runner, home);
  const dirs = await ensureDirs([
    ...new Set([join(gitCommonDir, "hooks"), ...hooks, ...modules.map((dir) => join(dir, "hooks"))]),
  ]);
  const files = await existing(
    [...modules.map((dir) => join(dir, "config")), ...(await worktreeConfigs(gitCommonDir))],
    "file",
  );

  return { dirs, files: [...new Set(files)] };
};
