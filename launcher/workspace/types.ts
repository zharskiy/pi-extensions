export interface Workspace {
  cwd: string;
  repoRoot: string;
  gitDir?: string;
  gitCommonDir?: string;
  isGitRepo: boolean;
  nested?: Workspace[];
  nodeProjects?: string[];
  nodeProjectsCapped?: boolean;
}

export const gitDirOf = (workspace: Workspace, gitCommonDir: string) => workspace.gitDir ?? gitCommonDir;

export const gitRepos = (workspace: Workspace): Workspace[] =>
  workspace.isGitRepo ? [workspace] : (workspace.nested ?? []);

export const mountedGitDirs = (workspace: Workspace) => [
  workspace.repoRoot,
  ...gitRepos(workspace)
    .map((repo) => repo.gitCommonDir)
    .filter((dir) => dir !== undefined),
];
