import { realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { type CommandRunner, errorMessage, isWithin, LauncherError } from "../../shared/index.ts";
import { gitRepos, type Workspace } from "../types.ts";
import { inertGitOptions } from "./command.ts";

const FILE_ORIGIN = "file:";

const MISSING_GIT = "git: command not found";

const OWN_CONFIG_FILES = ["config", "config.worktree"];

const between = (root: string, dir: string): string[] =>
  dir === root || dirname(dir) === dir ? [] : [dir, ...between(root, dirname(dir))];

const depthOf = (path: string) => path.split(sep).length;

const byDepth = (left: string, right: string) => depthOf(left) - depthOf(right) || left.localeCompare(right);

export const workspaceSelfBinds = (workspace: Workspace) => {
  const dirs = (workspace.nested ?? []).flatMap((repo) => between(workspace.repoRoot, repo.repoRoot));

  return [...new Set(dirs)].sort(byDepth);
};

export const workspaceNotices = (workspace: Workspace) => {
  const count = workspace.isGitRepo ? 0 : (workspace.nested?.length ?? 0);
  const noun = count === 1 ? "repository" : "repositories";

  return count > 0 ? [`pi-sandbox: workspace with ${count} ${noun}, git metadata protected`] : [];
};

export const workspaceConfigRefusal = (path: string) =>
  new LauncherError(
    `workspace: git configuration ${path} lies inside the workspace, refusing`,
    "move it out of the workspace, or start pi inside a repository",
  );

export const nestedRepoDirs = (workspace: Workspace) =>
  gitRepos(workspace).flatMap((repo) =>
    [repo.repoRoot, repo.gitCommonDir, repo.gitDir].filter((dir) => dir !== undefined),
  );

export const outsideNestedRepos = (workspace: Workspace, path: string) =>
  isWithin(path, workspace.repoRoot) && !nestedRepoDirs(workspace).some((dir) => isWithin(path, dir));

const originsOf = (stdout: string) => {
  const fields = stdout.split("\0");

  return Array.from({ length: Math.floor(fields.length / 3) }, (_, index) => ({
    scope: fields[index * 3] ?? "",
    origin: fields[index * 3 + 1] ?? "",
  }));
};

const configListing = (cwd: string, runner: CommandRunner, emptyHooksDir: string) =>
  runner
    .run(
      "git",
      [...inertGitOptions(emptyHooksDir), "config", "--list", "--show-origin", "--show-scope", "-z"],
      {
        cwd,
      },
    )
    .catch((error: unknown) =>
      errorMessage(error) === MISSING_GIT ? undefined : { code: -1, stdout: "", stderr: errorMessage(error) },
    );

const listingRefusal = (cwd: string, stderr: string) =>
  new LauncherError(`git: could not list the git configuration of ${cwd}: ${stderr.trim()}`);

const filesOf = async (cwd: string, stdout: string) => {
  const files = originsOf(stdout)
    .filter(({ scope, origin }) => scope !== "command" && origin.startsWith(FILE_ORIGIN))
    .map(({ origin }) => resolve(cwd, origin.slice(FILE_ORIGIN.length)));
  const real = await Promise.all(files.map((file) => realpath(file).catch(() => file)));

  return [...new Set([...files, ...real])];
};

export const gitConfigFiles = async (
  repoRoot: string,
  gitDirs: string[],
  runner: CommandRunner,
  emptyHooksDir: string,
) => {
  const result = await configListing(repoRoot, runner, emptyHooksDir);

  if (result === undefined || result.code !== 0) {
    throw listingRefusal(repoRoot, result?.stderr ?? MISSING_GIT);
  }

  const own = gitDirs.flatMap((dir) => OWN_CONFIG_FILES.map((name) => join(dir, name)));

  return (await filesOf(repoRoot, result.stdout)).filter((file) => !own.includes(file));
};

const rootConfigFiles = async (root: string, runner: CommandRunner, emptyHooksDir: string) => {
  const result = await configListing(root, runner, emptyHooksDir);

  if (result === undefined) {
    return [];
  }

  if (result.code !== 0) {
    throw listingRefusal(root, result.stderr);
  }

  return filesOf(root, result.stdout);
};

const repoConfigFiles = (repo: Workspace, runner: CommandRunner, emptyHooksDir: string) =>
  gitConfigFiles(
    repo.repoRoot,
    [repo.gitCommonDir, repo.gitDir].filter((dir) => dir !== undefined),
    runner,
    emptyHooksDir,
  );

export const assertWorkspaceGitConfig = async (
  workspace: Workspace,
  runner: CommandRunner,
  emptyHooksDir: string,
) => {
  const listed = await Promise.all([
    rootConfigFiles(workspace.repoRoot, runner, emptyHooksDir),
    ...gitRepos(workspace).map((repo) => repoConfigFiles(repo, runner, emptyHooksDir)),
  ]);
  const inside = listed.flat().find((file) => outsideNestedRepos(workspace, file));

  if (inside !== undefined) {
    throw workspaceConfigRefusal(inside);
  }
};
