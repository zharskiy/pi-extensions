export interface Workspace {
  cwd: string;
  repoRoot: string;
  gitCommonDir?: string;
  isGitRepo: boolean;
}
