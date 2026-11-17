import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  expandHome,
  isWithin,
  LauncherError,
  launcherPaths,
  outermostPaths,
  printable,
  realOrResolvedSync,
} from "../shared/index.ts";
import { overlapOf, type Protected, protectedPaths, withRealForm } from "./mounts.ts";
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
  nested: string[];
  notices: string[];
}

const MOUNT_SYNTAX = /[,:]/;

const CONTROL_CHARACTER = /\p{Cc}/u;

const ROOT_ONLY_HOME = [".local/bin", "Library"];

const SYSTEM_DIRS = ["/etc", "/usr", "/opt", "/System", "/Library", "/bin", "/sbin"];

const SYSTEM_PARENTS = ["/private", "/var"];

const lexicalRoot = (root: string, home?: string) => resolve(expandHome(root, home));

const refusal = (root: string, problem: string) =>
  new LauncherError(
    `config: workspaceRoots.roots: ${printable(root)} ${problem}`,
    "name the project folders themselves in workspaceRoots.roots",
  );

const guardedPaths = (context: RootGuardContext, homes: string[]): Protected[] => {
  const configDir = dirname(launcherPaths(context).userConfigFile);
  const listed = [
    ...ROOT_ONLY_HOME.map((name) => ({ path: join(context.home, name), reason: `~/${name}`, under: true })),
    { path: configDir, reason: "the launcher config dir", under: true },
    ...SYSTEM_DIRS.map((path) => ({ path, reason: path, under: true })),
    ...SYSTEM_PARENTS.map((path) => ({ path, reason: path, under: false })),
  ];
  const workspaceGuard = protectedPaths(context)
    .filter((entry) => !homes.includes(entry.path))
    .map((entry) => ({ ...entry, under: true }));

  return [...workspaceGuard, ...listed.flatMap(withRealForm)];
};

export const pathTextProblem = (path: string): RootProblem | undefined => {
  if (CONTROL_CHARACTER.test(path)) {
    return { kind: "control" };
  }

  return MOUNT_SYNTAX.test(path) ? { kind: "mount-syntax" } : undefined;
};

const problemOf = (resolved: string, context: RootGuardContext): RootProblem | undefined => {
  const textProblem = pathTextProblem(resolved);

  if (textProblem !== undefined) {
    return textProblem;
  }

  const homes = [resolve(context.home), realOrResolvedSync(context.home)];

  if (homes.some((home) => isWithin(home, resolved))) {
    return { kind: "home" };
  }

  const clash = guardedPaths(context, homes)
    .map((entry) => ({ entry, overlap: overlapOf(resolved, entry) }))
    .find((found) => found.overlap !== undefined);

  if (clash === undefined) {
    return undefined;
  }

  const kind = clash.overlap === "inside" ? "inside" : "holds";

  return { kind, name: clash.entry.reason, path: clash.entry.path };
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

interface RootEntry {
  root: string;
  resolved: string;
}

const notShared = (root: string, reason: string) =>
  `workspaceRoots: ${printable(root)} ${reason}, not shared`;

const rootNotices = (listed: RootEntry[], present: RootEntry[], shared: string[]) => {
  const inner = listed
    .filter((entry) => !shared.includes(entry.resolved))
    .filter((entry, index, all) => all.findIndex((other) => other.resolved === entry.resolved) === index);
  const outerOf = (entry: RootEntry) => {
    const share = shared.find((root) => isWithin(entry.resolved, root));

    return present.find((other) => other.resolved === share);
  };
  const nestedOf = (entry: RootEntry) => {
    const outer = isFolder(entry.resolved) ? outerOf(entry) : undefined;

    return outer === undefined
      ? []
      : [
          `workspaceRoots: ${printable(entry.root)} is inside ${printable(outer.root)} and is shared through it`,
        ];
  };
  const noticesOf = (entry: RootEntry) => {
    if (!isFolder(entry.resolved)) {
      return [notShared(entry.root, "does not exist")];
    }

    return outerOf(entry) === undefined
      ? [notShared(entry.root, `leads to ${printable(entry.resolved)}, outside the shared roots`)]
      : [];
  };

  return { nested: inner.flatMap(nestedOf), notices: inner.flatMap(noticesOf) };
};

export const sharedRootsOf = (workspaceRoots: WorkspaceRoots, context: RootGuardContext): SharedRoots => {
  const entries = configuredRoots(workspaceRoots.roots, context.home);

  entries.forEach((entry) => {
    assertShareable(entry.root, entry.resolved, context);
  });

  const listed = workspaceRoots.roots.map((root) => ({
    root,
    resolved: realOrResolvedSync(lexicalRoot(root, context.home)),
  }));
  const present = entries.filter((entry) => isFolder(entry.resolved));
  const absent = entries.filter((entry) => !isFolder(entry.resolved));
  const roots = outermostPaths(present.map((entry) => entry.resolved));

  return { roots, missing: absent.map((entry) => entry.resolved), ...rootNotices(listed, present, roots) };
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
      `${printable(outside)} is outside the allowed workspace roots (workspaceRoots.roots: ${workspaceRoots.roots.map(printable).join(", ")})`,
      "start pi inside one of the workspaceRoots, or add the folder to workspaceRoots.roots",
    );
  }
};
