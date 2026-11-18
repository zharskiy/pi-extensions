import { dirname, join } from "node:path";
import { isWithin, LauncherError, lstatOrUndefined } from "../../shared/index.ts";
import { byDepth, dirsBetween, realOrPending, unique } from "../paths.ts";
import type { Workspace } from "../types.ts";
import { findModuleGitDirs, gitRefusal, lstatKind } from "./layout.ts";
import { workspaceSelfBinds } from "./workspace.ts";

export interface GitOverlay {
  selfBinds: string[];
  readOnlyDirs: string[];
}

export interface ProtectedGitPaths {
  gitCommonDir: string;
  modules: string[];
  hooksDirs: string[];
  workspaceRoot?: string;
}

export const findProtectedGitPaths = async (
  gitCommonDir: string,
  workspaceRoot?: string,
  knownModules?: string[],
): Promise<ProtectedGitPaths> => {
  const modules = knownModules ?? (await findModuleGitDirs(gitCommonDir));
  const hooksDirs = [gitCommonDir, ...modules].map((dir) => join(dir, "hooks"));

  return workspaceRoot === undefined
    ? { gitCommonDir, modules, hooksDirs }
    : { gitCommonDir, modules, hooksDirs, workspaceRoot };
};

const checkedDir = async (path: string) => {
  if ((await lstatKind(path, "dir")) === "other") {
    throw gitRefusal(path, "is not a directory");
  }

  if ((await realOrPending(path)) !== path) {
    throw gitRefusal(path, "goes through a symbolic link");
  }
};

const selfBindsOf = async (workspace: Workspace, paths: ProtectedGitPaths) => {
  const { gitCommonDir, workspaceRoot } = paths;
  const roots = [
    workspace.repoRoot,
    ...(isWithin(gitCommonDir, workspace.repoRoot) ? [] : [gitCommonDir]),
    ...(workspaceRoot === undefined ? [] : [workspaceRoot]),
  ];
  const rootOf = (path: string) =>
    roots.filter((root) => isWithin(path, root)).sort((first, second) => second.length - first.length)[0];
  const candidates = unique([
    gitCommonDir,
    ...paths.hooksDirs.flatMap((dir) => {
      const root = rootOf(dir);

      return root === undefined ? [] : dirsBetween(root, dirname(dir));
    }),
  ]).filter((path) => !roots.includes(path) && rootOf(path) !== undefined);
  const real = await Promise.all(
    candidates.map(async (path) => (await lstatOrUndefined(path))?.isDirectory()),
  );

  return candidates.filter((_, index) => real[index] === true).sort(byDepth);
};

export const protectedGitOverlay = async (
  workspace: Workspace,
  paths: ProtectedGitPaths,
): Promise<GitOverlay> => {
  await Promise.all(paths.hooksDirs.map(checkedDir));

  return { selfBinds: await selfBindsOf(workspace, paths), readOnlyDirs: paths.hooksDirs };
};

const changedWhileStarting = (path: string) =>
  new LauncherError(`workspace: ${path} changed while pi was starting, refusing`, "run pi again");

const unchangedDir = async (path: string) => {
  const info = await lstatOrUndefined(path);

  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw changedWhileStarting(path);
  }

  await checkedDir(path);
};

export const protectedWorkspaceOverlay = async (workspace: Workspace): Promise<GitOverlay> => {
  const dirs = workspace.bareDirs ?? [];

  await Promise.all(dirs.map(unchangedDir));

  return { selfBinds: workspaceSelfBinds(workspace), readOnlyDirs: dirs };
};
