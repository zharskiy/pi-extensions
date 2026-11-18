import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { lstatOrUndefined } from "../../shared/index.ts";
import type { Workspace } from "../types.ts";
import {
  assertOwnCommondir,
  findModuleGitDirs,
  findWorktreeGitDirs,
  gitLayoutAt,
  gitRefusal,
  pointerPath,
  readGitPointer,
} from "./layout.ts";

const ALTERNATES = [
  ["objects", "info", "alternates"],
  ["objects", "info", "http-alternates"],
];

const assertWorktreePointers = async (worktreeDir: string, gitCommonDir: string) => {
  await readGitPointer(join(worktreeDir, "gitdir"));

  const commondir = join(worktreeDir, "commondir");
  const text = await readGitPointer(commondir);

  if (text === undefined) {
    return;
  }

  const target = await realpath(pointerPath(worktreeDir, text)).catch(() => "a missing directory");

  if (target !== gitCommonDir) {
    throw gitRefusal(commondir, `points at ${target}, not ${gitCommonDir}`);
  }
};

export const assertGitIntegrity = async (workspace: Workspace): Promise<string[]> => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return [];
  }

  const layout = await gitLayoutAt(workspace.repoRoot);
  const gitDir = workspace.gitDir ?? gitCommonDir;

  if (layout.gitDir !== gitDir || layout.gitCommonDir !== gitCommonDir) {
    throw gitRefusal(join(workspace.repoRoot, ".git"), `now leads to ${layout.gitDir}, not ${gitDir}`);
  }

  const worktrees = await findWorktreeGitDirs(gitCommonDir);

  await Promise.all(worktrees.map((dir) => assertWorktreePointers(dir, gitCommonDir)));

  const modules = await findModuleGitDirs(gitCommonDir);

  await Promise.all([gitCommonDir, ...modules].map(assertOwnCommondir));

  return modules;
};

export const gitAlternatesNotices = async (workspace: Workspace) => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return [];
  }

  const found = await Promise.all(
    ALTERNATES.map(async (parts) => {
      const path = join(gitCommonDir, ...parts);

      return (await lstatOrUndefined(path)) === undefined
        ? []
        : [
            `git: ${path} is present, so host git also reads objects from the places it lists; check it if you did not set it up`,
          ];
    }),
  );

  return found.flat();
};
