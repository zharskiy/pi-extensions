export interface Workspace {
  cwd: string;
  repoRoot: string;
  gitDir?: string;
  gitCommonDir?: string;
  isGitRepo: boolean;
}

export const gitDirOf = (workspace: Workspace, gitCommonDir: string) => workspace.gitDir ?? gitCommonDir;
