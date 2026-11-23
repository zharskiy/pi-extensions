import { realpath } from "node:fs/promises";
import { errorMessage, LauncherError } from "../shared/index.ts";
import { findGitRoot, gitLayoutOf } from "./git/layout.ts";
import { type OverlayScan, scanOverlays } from "./overlay-scan.ts";
import type { Workspace } from "./types.ts";

export interface DiscoverOptions {
  overlays?: boolean;
  scanBudget?: number;
}

export interface WorkspaceFolder {
  realCwd: string;
  root?: string;
}

const MAX_OVERLAYS = 512;

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

const overlaysOf = (
  scan: OverlayScan | undefined,
): Pick<Workspace, "overlays" | "overlaysCapped" | "overlaysTruncated"> => {
  if (scan === undefined) {
    return { overlays: [] };
  }

  if (scan.truncated) {
    return { overlays: [], overlaysTruncated: true };
  }

  return scan.overlays.length > MAX_OVERLAYS
    ? { overlays: [], overlaysCapped: true }
    : { overlays: scan.overlays };
};

export const workspaceFolder = async (cwd: string): Promise<WorkspaceFolder> => {
  const realCwd = await realPath(cwd);
  const root = await findGitRoot(realCwd);

  return root === undefined ? { realCwd } : { realCwd, root };
};

export const discoverWorkspace = async (
  folder: WorkspaceFolder,
  options: DiscoverOptions = {},
): Promise<Workspace> => {
  const { realCwd, root } = folder;

  if (root === undefined) {
    return { cwd: realCwd, repoRoot: realCwd, isGitRepo: false, overlays: [] };
  }

  const [repo, scan] = await Promise.all([
    repoAt(root, realCwd),
    options.overlays === false ? undefined : scanOverlays(root, options.scanBudget),
  ]);

  return { ...repo, ...overlaysOf(scan) };
};
