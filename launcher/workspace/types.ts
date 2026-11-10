import type { GitConfigListing } from "./git/config.ts";

export interface DetachedCheckout {
  repoRoot: string;
  missing: boolean;
}

export interface Workspace {
  cwd: string;
  repoRoot: string;
  gitDir?: string;
  gitCommonDir?: string;
  isGitRepo: boolean;
  gitConfig?: GitConfigListing;
  nested?: Workspace[];
  overlays?: string[];
  overlaysCapped?: boolean;
  masked?: string[];
  detached?: DetachedCheckout[];
  bareDirs?: string[];
}

export const gitDirsOf = (repo: Workspace) => [
  ...new Set([repo.gitCommonDir, repo.gitDir].filter((dir) => dir !== undefined)),
];

export const gitRepos = (workspace: Workspace): Workspace[] =>
  workspace.isGitRepo ? [workspace] : (workspace.nested ?? []);

export const mountedGitDirs = (workspace: Workspace) => [
  workspace.repoRoot,
  ...gitRepos(workspace)
    .map((repo) => repo.gitCommonDir)
    .filter((dir) => dir !== undefined),
];
