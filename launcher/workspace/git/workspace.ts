import { dirname, join } from "node:path";
import { isWithin, LauncherError } from "../../shared/index.ts";
import { byDepth, dirsBetween, unique } from "../paths.ts";
import { gitDirsOf, gitRepos, type Workspace } from "../types.ts";
import { configFilesOf, EMPTY_GIT_CONFIG, type GitConfigListing, missingInclude } from "./config.ts";

const OWN_CONFIG_FILES = ["config", "config.worktree"];

export const workspaceSelfBinds = (workspace: Workspace) =>
  unique([
    ...[...(workspace.nested ?? []), ...(workspace.detached ?? [])].flatMap((repo) =>
      dirsBetween(workspace.repoRoot, repo.repoRoot),
    ),
    ...(workspace.bareDirs ?? []).flatMap((dir) => dirsBetween(workspace.repoRoot, dirname(dir))),
  ]).sort(byDepth);

const LISTED = 20;

const listOf = (paths: string[]) =>
  paths.length > LISTED
    ? `${paths.slice(0, LISTED).join(", ")} and ${paths.length - LISTED} more`
    : paths.join(", ");

const listNotice = (paths: string[], text: (list: string) => string) =>
  paths.length === 0 ? [] : [`pi-sandbox: ${text(listOf(paths))}`];

const detachedRoots = (workspace: Workspace, missing: boolean) =>
  (workspace.detached ?? [])
    .filter((checkout) => checkout.missing === missing)
    .map((checkout) => checkout.repoRoot);

export const workspaceNotices = (workspace: Workspace) => {
  const count = workspace.isGitRepo ? 0 : (workspace.nested?.length ?? 0);
  const noun = count === 1 ? "repository" : "repositories";

  return [
    ...(count > 0 ? [`pi-sandbox: workspace with ${count} ${noun}, git metadata protected`] : []),
    ...listNotice(
      detachedRoots(workspace, false),
      (list) =>
        `${list}: the git dir lies outside this folder, so git does not work there in the sandbox; start pi inside the checkout to use git there`,
    ),
    ...listNotice(
      detachedRoots(workspace, true),
      (list) =>
        `${list}: .git points at a git dir that no longer exists, so the sandbox sees a plain folder; delete the .git file, or run git worktree prune in the repository that owned it`,
    ),
    ...listNotice(
      workspace.bareDirs ?? [],
      (list) =>
        `${list}: bare repositories, read-only in the sandbox; clone and fetch from them work, push does not`,
    ),
    ...listNotice(
      workspace.masked ?? [],
      (list) =>
        `cannot read ${list}; the sandbox sees them as empty read-only folders, and git there shows the files a repository tracks in them as deleted`,
    ),
  ];
};

export const workspaceConfigRefusal = (path: string) =>
  new LauncherError(
    `workspace: git configuration ${path} lies inside the workspace, refusing`,
    "move it out of the workspace, or start pi inside a repository",
  );

export const nestedRepoDirs = (workspace: Workspace) =>
  gitRepos(workspace).flatMap((repo) => [repo.repoRoot, ...gitDirsOf(repo)]);

export const outsideNestedRepos = (workspace: Workspace, path: string) =>
  isWithin(path, workspace.repoRoot) && !nestedRepoDirs(workspace).some((dir) => isWithin(path, dir));

export const ownConfigFiles = (gitDirs: string[]) =>
  gitDirs.flatMap((dir) => OWN_CONFIG_FILES.map((name) => join(dir, name)));

export const assertWorkspaceGitConfig = async (workspace: Workspace, root: GitConfigListing) => {
  const listed = await Promise.all([
    configFilesOf(root),
    ...gitRepos(workspace).map((repo) =>
      configFilesOf(repo.gitConfig ?? EMPTY_GIT_CONFIG, ownConfigFiles(gitDirsOf(repo))),
    ),
  ]);
  const inside = listed.flatMap((found) => found.files).find((file) => outsideNestedRepos(workspace, file));

  if (inside !== undefined) {
    throw workspaceConfigRefusal(inside);
  }

  const missing = listed
    .flatMap((found) => found.missing)
    .find((file) => isWithin(file.path, workspace.repoRoot) || isWithin(file.real, workspace.repoRoot));

  if (missing !== undefined) {
    throw missingInclude(missing);
  }
};
