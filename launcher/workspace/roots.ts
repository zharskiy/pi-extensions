import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  expandHome,
  isWithin,
  LauncherError,
  launcherPaths,
  outermostPaths,
  realOrResolvedSync,
} from "../shared/index.ts";
import { protectedPaths } from "./mounts.ts";
import { mountedGitDirs, type Workspace } from "./types.ts";

interface WorkspaceRoots {
  roots: string[];
}

export interface RootGuardContext {
  home: string;
  env: NodeJS.ProcessEnv;
}

export type RootProblem =
  | { kind: "control" }
  | { kind: "mount-syntax" }
  | { kind: "home" }
  | { kind: "inside"; name: string; path: string }
  | { kind: "holds"; name: string; path: string };

export type RootVerdict =
  | { ok: true; resolved: string; exists: boolean }
  | { ok: false; problem: RootProblem };

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

const ROOT_ONLY_HOME = [".local/bin", "Library"];

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
    ...ROOT_ONLY_HOME.map((name) => ({ path: join(context.home, name), name: `~/${name}`, inside: true })),
    { path: configDir, name: "the launcher config dir", inside: true },
    ...SYSTEM_DIRS.map((path) => ({ path, name: path, inside: true })),
    ...SYSTEM_PARENTS.map((path) => ({ path, name: path, inside: false })),
  ];

  return listed.flatMap(bothForms);
};

const clashes = (resolved: string) => (entry: Guarded) =>
  isWithin(entry.path, resolved) || (entry.inside && isWithin(resolved, entry.path));

const problemOf = (resolved: string, context: RootGuardContext): RootProblem | undefined => {
  if (CONTROL_CHARACTER.test(resolved)) {
    return { kind: "control" };
  }

  if (MOUNT_SYNTAX.test(resolved)) {
    return { kind: "mount-syntax" };
  }

  const homes = [resolve(context.home), realOrResolvedSync(context.home)];

  if (homes.some((home) => isWithin(home, resolved))) {
    return { kind: "home" };
  }

  const clash = guardedPaths(context, homes).find(clashes(resolved));

  if (clash === undefined) {
    return undefined;
  }

  return isWithin(clash.path, resolved)
    ? { kind: "holds", name: clash.name, path: clash.path }
    : { kind: "inside", name: clash.name, path: clash.path };
};

const refusalOf = (root: string, problem: RootProblem) => {
  if (problem.kind === "control") {
    return refusal(JSON.stringify(root), "holds a newline or another control character");
  }

  if (problem.kind === "mount-syntax") {
    return refusal(root, 'holds "," or ":", which colima\'s --mount cannot take');
  }

  return problem.kind === "home"
    ? refusal(root, "is the home dir or holds it, which would share all of it with the sandbox VM")
    : refusal(root, `overlaps ${problem.name} (${problem.path}), which the sandbox VM must not see`);
};

const assertShareable = (root: string, resolved: string, context: RootGuardContext) => {
  const problem = problemOf(resolved, context);

  if (problem !== undefined) {
    throw refusalOf(root, problem);
  }
};

export const rootRefusal = (root: string, problem: RootProblem) => refusalOf(root, problem).message;

const isFolder = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const configuredRoots = (roots: string[], home?: string) => {
  const entries = roots.map((root) => ({ root, lexical: lexicalRoot(root, home) }));
  const kept = new Set(outermostPaths(entries.map((entry) => entry.lexical)));

  return entries
    .filter((entry) => kept.has(entry.lexical))
    .filter((entry, index, all) => all.findIndex((other) => other.lexical === entry.lexical) === index)
    .map((entry) => ({ root: entry.root, resolved: realOrResolvedSync(entry.lexical) }));
};

export const checkRoot = (root: string, context: RootGuardContext): RootVerdict => {
  const resolved = realOrResolvedSync(lexicalRoot(root, context.home));
  const problem = problemOf(resolved, context);

  return problem === undefined ? { ok: true, resolved, exists: isFolder(resolved) } : { ok: false, problem };
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
    roots: outermostPaths(present.map((entry) => entry.resolved)),
    missing: absent.map((entry) => entry.resolved),
    notices,
  };
};

export const assertWithinWorkspaceRoots = (
  workspace: Workspace,
  workspaceRoots: WorkspaceRoots | undefined,
  home: string,
) => {
  if (workspaceRoots === undefined) {
    return;
  }

  const roots = configuredRoots(workspaceRoots.roots, home).map((entry) => entry.resolved);
  const outside = mountedGitDirs(workspace).find((path) => !roots.some((root) => isWithin(path, root)));

  if (outside !== undefined) {
    throw new LauncherError(
      `${outside} is outside the allowed workspace roots (workspaceRoots.roots: ${workspaceRoots.roots.join(", ")})`,
      "start pi inside one of the workspaceRoots, or add the folder to workspaceRoots.roots",
    );
  }
};
