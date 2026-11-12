import { statSync } from "node:fs";
import { join } from "node:path";
import { expandHome, isWithin, LauncherError, realOrResolvedSync } from "../shared/index.ts";
import { mountedGitDirs, type Workspace } from "./types.ts";

interface WorkspaceRoots {
  roots: string[];
}

interface RootGuardPaths {
  home: string;
  agentDir: string;
  stateDir: string;
}

interface SharedRoots {
  roots: string[];
  notices: string[];
}

const MOUNT_SYNTAX = /[,:]/;

const resolveRoot = (root: string, home?: string) => realOrResolvedSync(expandHome(root, home));

const refusal = (root: string, problem: string) =>
  new LauncherError(
    `config: workspaceRoots.roots: ${root} ${problem}`,
    "name the project folders themselves in workspaceRoots.roots",
  );

const overlaps = (path: string, other: string) => isWithin(path, other) || isWithin(other, path);

const assertShareable = (root: string, resolved: string, paths: RootGuardPaths) => {
  if (MOUNT_SYNTAX.test(resolved)) {
    throw refusal(root, 'holds "," or ":", which colima\'s --mount cannot take');
  }

  if (isWithin(realOrResolvedSync(paths.home), resolved)) {
    throw refusal(root, "is the home dir or holds it, which would share all of it with the sandbox VM");
  }

  const guarded = [
    { path: realOrResolvedSync(paths.agentDir), name: "the pi agent dir" },
    { path: realOrResolvedSync(paths.stateDir), name: "the launcher state dir" },
    { path: realOrResolvedSync(join(paths.home, ".ssh")), name: "~/.ssh" },
  ];
  const clash = guarded.find((entry) => overlaps(resolved, entry.path));

  if (clash !== undefined) {
    throw refusal(root, `overlaps ${clash.name} (${clash.path}), which the sandbox VM must not see`);
  }
};

const isFolder = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const outermost = (paths: string[]) => {
  const unique = [...new Set(paths)];

  return unique.filter((path) => !unique.some((other) => other !== path && isWithin(path, other)));
};

export const sharedRootsOf = (workspaceRoots: WorkspaceRoots, paths: RootGuardPaths): SharedRoots => {
  const entries = workspaceRoots.roots.map((root) => ({ root, resolved: resolveRoot(root, paths.home) }));

  entries.forEach((entry) => {
    assertShareable(entry.root, entry.resolved, paths);
  });

  const present = entries.filter((entry) => isFolder(entry.resolved));
  const notices = entries
    .filter((entry) => !isFolder(entry.resolved))
    .map((entry) => `workspaceRoots: ${entry.root} does not exist, not shared`);

  return { roots: outermost(present.map((entry) => entry.resolved)), notices };
};

export const assertWithinWorkspaceRoots = (
  workspace: Workspace,
  workspaceRoots: WorkspaceRoots | undefined,
) => {
  if (workspaceRoots === undefined) {
    return;
  }

  const roots = workspaceRoots.roots.map((root) => resolveRoot(root));
  const outside = mountedGitDirs(workspace).find((path) => !roots.some((root) => isWithin(path, root)));

  if (outside !== undefined) {
    throw new LauncherError(
      `${outside} is outside the allowed workspace roots (workspaceRoots.roots: ${workspaceRoots.roots.join(", ")})`,
      "start pi inside one of the workspaceRoots, or add the folder to workspaceRoots.roots",
    );
  }
};
