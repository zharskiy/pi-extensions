export interface Workspace {
  cwd: string;
  repoRoot: string;
  gitDir?: string;
  gitCommonDir?: string;
  isGitRepo: boolean;
}
