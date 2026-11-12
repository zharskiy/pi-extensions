import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expandHome, isWithin, LauncherError, launcherPaths, realOrResolvedSync } from "../shared/index.ts";
import { protectedPaths } from "./mounts.ts";
import { mountedGitDirs, type Workspace } from "./types.ts";

interface WorkspaceRoots {
  roots: string[];
}

interface RootGuardContext {
  home: string;
  env: NodeJS.ProcessEnv;
}

interface SharedRoots {
  roots: string[];
  missing: string[];
  notices: string[];
}

interface Guarded {
  path: string;
  name: string;
  inside: boolean;
}

const MOUNT_SYNTAX = /[,:]/;

const CONTROL_CHARACTER = /\p{Cc}/u;

const SYSTEM_DIRS = ["/etc", "/usr", "/opt", "/System", "/Library", "/bin", "/sbin"];

const SYSTEM_PARENTS = ["/private", "/var"];

const lexicalRoot = (root: string, home?: string) => resolve(expandHome(root, home));

const refusal = (root: string, problem: string) =>
  new LauncherError(
    `config: workspaceRoots.roots: ${root} ${problem}`,
    "name the project folders themselves in workspaceRoots.roots",
  );

const bothForms = (entry: Guarded) => {
  const real = realOrResolvedSync(entry.path);

  return real === entry.path ? [entry] : [entry, { ...entry, path: real }];
};

const guardedPaths = (context: RootGuardContext, homes: string[]): Guarded[] => {
  const configDir = dirname(launcherPaths(context).userConfigFile);
  const listed = [
    ...protectedPaths(context)
      .filter((entry) => !homes.includes(entry.path))
      .map((entry) => ({ path: entry.path, name: entry.reason, inside: true })),
    { path: configDir, name: "the launcher config dir", inside: true },
    ...SYSTEM_DIRS.map((path) => ({ path, name: path, inside: true })),
    ...SYSTEM_PARENTS.map((path) => ({ path, name: path, inside: false })),
  ];

  return listed.flatMap(bothForms);
};

const clashes = (resolved: string) => (entry: Guarded) =>
  isWithin(entry.path, resolved) || (entry.inside && isWithin(resolved, entry.path));

const assertShareable = (root: string, resolved: string, context: RootGuardContext) => {
  if (CONTROL_CHARACTER.test(resolved)) {
    throw refusal(JSON.stringify(root), "holds a newline or another control character");
  }

  if (MOUNT_SYNTAX.test(resolved)) {
    throw refusal(root, 'holds "," or ":", which colima\'s --mount cannot take');
  }

  const homes = [resolve(context.home), realOrResolvedSync(context.home)];

  if (homes.some((home) => isWithin(home, resolved))) {
    throw refusal(root, "is the home dir or holds it, which would share all of it with the sandbox VM");
  }

  const clash = guardedPaths(context, homes).find(clashes(resolved));

  if (clash !== undefined) {
    throw refusal(root, `overlaps ${clash.name} (${clash.path}), which the sandbox VM must not see`);
  }
};

const isFolder = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const outermost = (paths: string[]) => {
  const unique = [...new Set(paths)];

  return unique.filter((path) => !unique.some((other) => other !== path && isWithin(path, other)));
};

const configuredRoots = (roots: string[], home?: string) => {
  const entries = roots.map((root) => ({ root, lexical: lexicalRoot(root, home) }));
  const kept = new Set(outermost(entries.map((entry) => entry.lexical)));

  return entries
    .filter((entry) => kept.has(entry.lexical))
    .filter((entry, index, all) => all.findIndex((other) => other.lexical === entry.lexical) === index)
    .map((entry) => ({ root: entry.root, resolved: realOrResolvedSync(entry.lexical) }));
};

export const sharedRootsOf = (workspaceRoots: WorkspaceRoots, context: RootGuardContext): SharedRoots => {
  const entries = configuredRoots(workspaceRoots.roots, context.home);

  entries.forEach((entry) => {
    assertShareable(entry.root, entry.resolved, context);
  });

  const present = entries.filter((entry) => isFolder(entry.resolved));
  const absent = entries.filter((entry) => !isFolder(entry.resolved));
  const notices = absent.map((entry) => `workspaceRoots: ${entry.root} does not exist, not shared`);

  return {
    roots: outermost(present.map((entry) => entry.resolved)),
    missing: absent.map((entry) => entry.resolved),
    notices,
  };
};

export const assertWithinWorkspaceRoots = (
  workspace: Workspace,
  workspaceRoots: WorkspaceRoots | undefined,
) => {
  if (workspaceRoots === undefined) {
    return;
  }

  const roots = configuredRoots(workspaceRoots.roots).map((entry) => entry.resolved);
  const outside = mountedGitDirs(workspace).find((path) => !roots.some((root) => isWithin(path, root)));

  if (outside !== undefined) {
    throw new LauncherError(
      `${outside} is outside the allowed workspace roots (workspaceRoots.roots: ${workspaceRoots.roots.join(", ")})`,
      "start pi inside one of the workspaceRoots, or add the folder to workspaceRoots.roots",
    );
  }
};
