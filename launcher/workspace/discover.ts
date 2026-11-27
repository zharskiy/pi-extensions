import { realpath } from "node:fs/promises";
import { errorMessage, LauncherError } from "../shared/index.ts";
import { findGitRoot, gitLayoutOf } from "./git/layout.ts";
import type { Workspace } from "./types.ts";

export interface WorkspaceFolder {
  realCwd: string;
  root?: string;
}

const realPath = async (path: string) => {
  try {
    return await realpath(path);
  } catch (error) {
    throw new LauncherError(`${path}: ${errorMessage(error)}`);
  }
};

const realOrLexical = (path: string) => realpath(path).catch(() => path);

const repoAt = async (root: string, cwd: string): Promise<Workspace> => {
  const layout = await gitLayoutOf(root);
  const [gitDir, gitCommonDir] = await Promise.all([
    realOrLexical(layout.gitDir),
    realOrLexical(layout.gitCommonDir),
  ]);

  return { cwd, repoRoot: root, gitDir, gitCommonDir, isGitRepo: true };
};

export const workspaceFolder = async (cwd: string): Promise<WorkspaceFolder> => {
  const realCwd = await realPath(cwd);
  const root = await findGitRoot(realCwd);

  return root === undefined ? { realCwd } : { realCwd, root };
};

export const discoverWorkspace = async ({ realCwd, root }: WorkspaceFolder): Promise<Workspace> =>
  root === undefined ? { cwd: realCwd, repoRoot: realCwd, isGitRepo: false } : repoAt(root, realCwd);
