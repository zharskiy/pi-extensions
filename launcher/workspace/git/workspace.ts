import { dirname } from "node:path";
import { byDepth, dirsBetween, unique } from "../paths.ts";
import type { Workspace } from "../types.ts";

export const workspaceSelfBinds = (workspace: Workspace) =>
  unique([
    ...(workspace.nested ?? []).flatMap((repo) => dirsBetween(workspace.repoRoot, repo.repoRoot)),
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
    ...(count > 0 ? [`pi-sandbox: workspace with ${count} ${noun}`] : []),
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
  ];
};
