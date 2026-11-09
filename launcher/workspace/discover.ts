import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type CommandRunner, errorMessage, isWithin, LauncherError } from "../shared/index.ts";
import { inertGitOptions } from "./git/command.ts";
import { findGitRoot, gitLayoutAt } from "./git/layout.ts";
import { assertWorkspaceGitConfig } from "./git/workspace.ts";
import type { Workspace } from "./types.ts";
import { scanBudgetOf, scanWorkspace, type WorkspaceScan } from "./workspace-scan.ts";

export interface DiscoverOptions {
  lenient?: boolean;
  scanOverlays?: boolean;
  scanBudget?: number;
}

const NARROWER = "start pi in a narrower folder";

const MAX_NESTED_REPOS = 128;

const MAX_OVERLAYS = 512;

const realPath = async (path: string) => {
  try {
    return await realpath(path);
  } catch (error) {
    throw new LauncherError(`${path}: ${errorMessage(error)}`);
  }
};

const mismatch = (dotGit: string, found: string, reported: string) =>
  new LauncherError(
    `git: ${dotGit} leads to ${found}, but git reports ${reported}; refusing to mount a git dir git did not choose`,
    "check the repository's .git and commondir files and git's core.worktree setting",
  );

const unconfirmed = (dotGit: string, found: string) =>
  new LauncherError(
    `git: ${dotGit} leads to ${found}, but git does not open it as a repository; refusing to mount it`,
    "check the repository's .git file and run git status in it",
  );

const unprotected = (repo: string, error: unknown) =>
  new LauncherError(
    `workspace: ${repo} cannot be protected: ${errorMessage(error)}`,
    "fix or move that repository, or start pi inside it",
  );

const tooManyRepos = (root: string, count: number) =>
  new LauncherError(
    `workspace: ${root} holds ${count} repositories, more than the ${MAX_NESTED_REPOS} the launcher protects`,
    NARROWER,
  );

const tooLarge = (root: string, budget: number) =>
  new LauncherError(
    `workspace: ${root} has more than ${budget} directories to search for repositories, refusing`,
    NARROWER,
  );

const outsideRoot = (repo: string, root: string) =>
  new LauncherError(`workspace: ${repo} uses a git dir outside ${root}`, "start pi inside it");

const reportedByGit = async (cwd: string, runner: CommandRunner, emptyHooksDir: string) => {
  const result = await runner
    .run("git", [...inertGitOptions(emptyHooksDir), "rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd,
    })
    .catch(() => undefined);
  const [toplevel = "", commonDir = ""] = (result?.stdout ?? "").split("\n").map((line) => line.trim());

  if (result?.code !== 0 || toplevel === "" || commonDir === "") {
    return undefined;
  }

  return { repoRoot: await realPath(toplevel), gitCommonDir: await realPath(resolve(cwd, commonDir)) };
};

const confirmedRepo = async (
  root: string,
  cwd: string,
  runner: CommandRunner,
  emptyHooksDir: string,
): Promise<Workspace> => {
  const layout = await gitLayoutAt(root);
  const reported = await reportedByGit(cwd, runner, emptyHooksDir);

  if (reported === undefined) {
    throw unconfirmed(join(root, ".git"), layout.gitCommonDir);
  }

  if (reported.repoRoot !== root || reported.gitCommonDir !== layout.gitCommonDir) {
    throw mismatch(
      join(root, ".git"),
      layout.gitCommonDir,
      `${reported.repoRoot} with ${reported.gitCommonDir}`,
    );
  }

  return {
    cwd,
    repoRoot: root,
    gitDir: layout.gitDir,
    gitCommonDir: layout.gitCommonDir,
    isGitRepo: true,
  };
};

const nestedRepo = async (repo: string, root: string, runner: CommandRunner, emptyHooksDir: string) => {
  const confirmed = await confirmedRepo(repo, repo, runner, emptyHooksDir).catch((error: unknown) => {
    throw unprotected(repo, error);
  });
  const gitDirs = [confirmed.gitDir, confirmed.gitCommonDir].filter((dir) => dir !== undefined);

  if (!gitDirs.every((dir) => isWithin(dir, root))) {
    throw outsideRoot(repo, root);
  }

  return confirmed;
};

const overlaysOf = (scan: WorkspaceScan) =>
  scan.overlays.length > MAX_OVERLAYS ? { overlays: [], overlaysCapped: true } : { overlays: scan.overlays };

const lenientFolder = (cwd: string, scan: WorkspaceScan): Workspace => ({
  cwd,
  repoRoot: cwd,
  isGitRepo: false,
  nested: scan.repos.map((repo) => ({ cwd: repo, repoRoot: repo, isGitRepo: true })),
  ...overlaysOf(scan),
});

const strictFolder = async (
  cwd: string,
  scan: WorkspaceScan,
  runner: CommandRunner,
  emptyHooksDir: string,
  budget: number,
) => {
  if (scan.truncated) {
    throw tooLarge(cwd, budget);
  }

  const unreadable = scan.unreadable[0];

  if (unreadable !== undefined) {
    throw unprotected(unreadable.dir, `cannot read it (${unreadable.code})`);
  }

  if (scan.repos.length > MAX_NESTED_REPOS) {
    throw tooManyRepos(cwd, scan.repos.length);
  }

  const nested = await Promise.all(scan.repos.map((repo) => nestedRepo(repo, cwd, runner, emptyHooksDir)));
  const workspace: Workspace = {
    cwd,
    repoRoot: cwd,
    isGitRepo: false,
    nested,
    ...overlaysOf(scan),
  };

  await assertWorkspaceGitConfig(workspace, runner, emptyHooksDir);

  return workspace;
};

export const discoverWorkspace = async (
  cwd: string,
  runner: CommandRunner,
  emptyHooksDir: string,
  options: DiscoverOptions = {},
): Promise<Workspace> => {
  const realCwd = await realPath(cwd);
  const root = await findGitRoot(realCwd);

  const budget = scanBudgetOf(options.scanBudget);

  if (root === undefined) {
    const scan = await scanWorkspace(realCwd, "workspace", { overlays: options.scanOverlays, budget });

    return options.lenient === true
      ? lenientFolder(realCwd, scan)
      : strictFolder(realCwd, scan, runner, emptyHooksDir, budget);
  }

  const [repo, scan] = await Promise.all([
    confirmedRepo(root, realCwd, runner, emptyHooksDir),
    options.scanOverlays === false ? undefined : scanWorkspace(root, "git", { budget }),
  ]);

  return scan === undefined ? { ...repo, overlays: [] } : { ...repo, ...overlaysOf(scan) };
};
