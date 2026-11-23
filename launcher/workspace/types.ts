export interface Workspace {
  cwd: string;
  repoRoot: string;
  gitDir?: string;
  gitCommonDir?: string;
  isGitRepo: boolean;
  overlays?: string[];
  overlaysCapped?: boolean;
  overlaysTruncated?: boolean;
}

export const gitDirsOf = (workspace: Workspace) => [
  ...new Set([workspace.gitDir, workspace.gitCommonDir].filter((dir) => dir !== undefined)),
];
