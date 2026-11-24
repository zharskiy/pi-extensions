import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  expandHome,
  isWithin,
  LauncherError,
  launcherPaths,
  printable,
  realOrResolvedSync,
} from "../shared/index.ts";
import { protectedPaths } from "./mounts.ts";
import { gitDirsOf, type Workspace } from "./types.ts";

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

interface SharedRoot {
  root?: string;
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

const ROOT_KEY = "workspaceRoot";

const ROOT_HINT = "point workspaceRoot at the folder that holds your projects, not at your home or above it";

const refusal = (key: string, hint: string) => (root: string, problem: string) =>
  new LauncherError(`config: ${key}: ${printable(root)} ${problem}`, hint);

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
    { path: configDir, name: "pinata's config dir", inside: true },
    ...SYSTEM_DIRS.map((path) => ({ path, name: path, inside: true })),
    ...SYSTEM_PARENTS.map((path) => ({ path, name: path, inside: false })),
  ];

  return listed.flatMap(bothForms);
};

const clashes = (resolved: string) => (entry: Guarded) =>
  isWithin(entry.path, resolved) || (entry.inside && isWithin(resolved, entry.path));

export const pathTextProblem = (path: string): RootProblem | undefined => {
  if (CONTROL_CHARACTER.test(path)) {
    return { kind: "control" };
  }

  return MOUNT_SYNTAX.test(path) ? { kind: "mount-syntax" } : undefined;
};

export const shareProblem = (resolved: string, context: RootGuardContext): RootProblem | undefined => {
  const textProblem = pathTextProblem(resolved);

  if (textProblem !== undefined) {
    return textProblem;
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

export const pathRefusal = (key: string, hint: string, root: string, problem: RootProblem) => {
  const refuse = refusal(key, hint);

  if (problem.kind === "control") {
    return refuse(JSON.stringify(root), "holds a newline or another control character");
  }

  if (problem.kind === "mount-syntax") {
    return refuse(root, 'holds "," or ":", which colima\'s --mount cannot take');
  }

  return problem.kind === "home"
    ? refuse(root, "is the home dir or holds it, which would share all of it with the sandbox VM")
    : refuse(root, `overlaps ${problem.name} (${problem.path}), which the sandbox VM must not see`);
};

const refusalOf = (root: string, problem: RootProblem) => pathRefusal(ROOT_KEY, ROOT_HINT, root, problem);

export const rootRefusal = (root: string, problem: RootProblem) => refusalOf(root, problem).message;

const isFolder = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

export const checkRoot = (root: string, context: RootGuardContext): RootVerdict => {
  const resolved = realOrResolvedSync(lexicalRoot(root, context.home));
  const problem = shareProblem(resolved, context);

  return problem === undefined ? { ok: true, resolved, exists: isFolder(resolved) } : { ok: false, problem };
};

const shareableRoot = (root: string, context: RootGuardContext) => {
  const verdict = checkRoot(root, context);

  if (!verdict.ok) {
    throw refusalOf(root, verdict.problem);
  }

  return verdict;
};

export const sharedRootOf = (root: string, context: RootGuardContext): SharedRoot => {
  const verdict = shareableRoot(root, context);

  return verdict.exists
    ? { root: verdict.resolved, notices: [] }
    : { notices: [`workspaceRoot: ${printable(root)} is missing, so it is not shared until it exists`] };
};

export const requiredRoot = (root: string | undefined, context: RootGuardContext) => {
  if (root === undefined) {
    throw new LauncherError(
      "config: workspaceRoot is not set, so pi has no folder it may start in",
      `run pinata init, or set workspaceRoot in ${launcherPaths(context).userConfigFile} to the folder that holds your projects`,
    );
  }

  return root;
};

const outsideGitDir = (dir: string, workspace: Workspace, root: string) =>
  new LauncherError(
    `git: the git dir ${printable(dir)} of ${printable(workspace.repoRoot)} is outside the workspace root (workspaceRoot: ${printable(root)})`,
    "the sandbox mounts only the workspace root, so git would not work there; move the repository (or its main checkout) inside it, or point workspaceRoot at a folder that holds both",
  );

const missingRoot = (root: string) =>
  new LauncherError(
    `config: workspaceRoot: ${printable(root)} does not exist`,
    "create the folder, mount the volume it lives on, or point workspaceRoot at a folder that holds your projects",
  );

const assertProjectInsideRoot = (workspace: Workspace, root: string, resolved: string) => {
  if (!isFolder(resolved)) {
    throw missingRoot(root);
  }

  if (!isWithin(workspace.repoRoot, resolved)) {
    throw new LauncherError(
      `${printable(workspace.repoRoot)} is outside the workspace root (workspaceRoot: ${printable(root)})`,
      "start pi inside it, or point workspaceRoot at a folder that holds the project",
    );
  }
};

const assertInsideRoot = (workspace: Workspace, root: string, resolved: string) => {
  assertProjectInsideRoot(workspace, root, resolved);

  const outside = gitDirsOf(workspace).find((dir) => !isWithin(dir, resolved));

  if (outside !== undefined) {
    throw outsideGitDir(outside, workspace, root);
  }
};

export const assertWithinWorkspaceRoot = (
  workspace: Workspace,
  configured: string | undefined,
  context: RootGuardContext,
) => {
  const root = requiredRoot(configured, context);
  const { resolved } = shareableRoot(root, context);

  assertInsideRoot(workspace, root, resolved);
};

export const assertWithinHostRoot = (
  workspace: Workspace,
  configured: string | undefined,
  context: RootGuardContext,
) => {
  if (configured === undefined) {
    return;
  }

  const resolved = realOrResolvedSync(lexicalRoot(configured, context.home));

  assertProjectInsideRoot(workspace, configured, resolved);
};
