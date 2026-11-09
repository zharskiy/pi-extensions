import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { type CommandRunner, expandHome, isWithin, lstatOrUndefined } from "../../shared/index.ts";
import { protectedRealPathGuard } from "../mounts.ts";
import { gitDirOf, gitRepos, type Workspace } from "../types.ts";
import { inertGitOptions } from "./command.ts";
import { findModuleGitDirs, findWorktreeGitDirs, gitRefusal, lstatKind } from "./layout.ts";
import { gitConfigFiles, nestedRepoDirs, outsideNestedRepos, workspaceConfigRefusal } from "./workspace.ts";

export interface GitOverlay {
  selfBinds: string[];
  readOnlyDirs: string[];
  readOnlyFiles: string[];
}

export interface GitProtectContext {
  runner: CommandRunner;
  home: string;
  env: NodeJS.ProcessEnv;
  emptyHooksDir: string;
  engineSockets: string[];
  workspace?: Workspace;
}

export interface ProtectedGitPaths {
  gitCommonDir: string;
  modules: string[];
  dirs: string[];
  pins: string[];
  files: string[];
  workspaceRoot?: string;
}

export type GitPathGuard = (path: string) => string | undefined;

const WORKTREE_FILES = ["commondir", "gitdir", "config.worktree"];

const unique = (paths: string[]) => [...new Set(paths)];

const byDepth = (first: string, second: string) =>
  first.split(sep).length - second.split(sep).length || first.localeCompare(second);

const realOrPending = (path: string): Promise<string> =>
  realpath(path).catch(() => {
    const parent = dirname(path);

    return parent === path ? path : realOrPending(parent).then((real) => join(real, basename(path)));
  });

const configuredHooksPath = async (workspace: Workspace, context: GitProtectContext) => {
  const args = [
    ...inertGitOptions(context.emptyHooksDir),
    "config",
    "--show-scope",
    "--get-all",
    "core.hooksPath",
  ];
  const result = await context.runner.run("git", args, { cwd: workspace.cwd }).catch(() => undefined);
  const lines = result?.code === 0 ? result.stdout.split("\n") : [];
  const values = lines.flatMap((line) => {
    const tab = line.indexOf("\t");

    return tab > 0 && line.slice(0, tab) !== "command" && line.length > tab + 1 ? [line.slice(tab + 1)] : [];
  });

  return values.at(-1);
};

const hooksPathDirs = async (workspace: Workspace, gitCommonDir: string, context: GitProtectContext) => {
  const value = await configuredHooksPath(workspace, context);

  if (value === undefined) {
    return [];
  }

  const outer = context.workspace;
  const roots = [workspace.repoRoot, gitCommonDir, ...(outer === undefined ? [] : [outer.repoRoot])];
  const lexical = resolve(workspace.repoRoot, expandHome(value, context.home));
  const real = await realOrPending(lexical);

  if (outer !== undefined && (outsideNestedRepos(outer, real) || outsideNestedRepos(outer, lexical))) {
    throw workspaceConfigRefusal(real);
  }

  if (!roots.some((root) => isWithin(real, root))) {
    return [];
  }

  if (roots.some((root) => isWithin(lexical, root)) && real !== lexical) {
    throw gitRefusal(lexical, "(core.hooksPath) goes through a symbolic link the sandbox could repoint");
  }

  const held = [gitCommonDir, ...(outer === undefined ? [] : gitRepos(outer).map((repo) => repo.repoRoot))];

  if (roots.includes(real) || held.some((dir) => isWithin(dir, real))) {
    throw gitRefusal(real, "(core.hooksPath) is the repository or holds its git dir and cannot be read-only");
  }

  return [real];
};

export const gitPathGuard = (workspace: Workspace, context: GitProtectContext): GitPathGuard =>
  protectedRealPathGuard({
    home: context.home,
    env: context.env,
    repoRoot: workspace.repoRoot,
    engineSockets: context.engineSockets,
  });

const checkedLeaf = async (path: string, kind: "file" | "dir", guard: GitPathGuard) => {
  const found = await lstatKind(path, kind);

  if (found === "other") {
    throw gitRefusal(path, kind === "dir" ? "is not a directory" : "is not a regular file");
  }

  if ((await realOrPending(path)) !== path) {
    throw gitRefusal(path, "goes through a symbolic link");
  }

  const reason = guard(path);

  if (reason !== undefined) {
    throw gitRefusal(path, `may not be mounted (${reason})`);
  }

  return found === "match";
};

const ancestorsBelow = (path: string, root: string) => {
  const parts = relative(root, path).split(sep);

  return parts.slice(0, -1).map((_, index) => join(root, ...parts.slice(0, index + 1)));
};

const selfBindsOf = async (
  leaves: string[],
  workspace: Workspace,
  gitCommonDir: string,
  guard: GitPathGuard,
  workspaceRoot: string | undefined,
) => {
  const roots = [
    workspace.repoRoot,
    ...(isWithin(gitCommonDir, workspace.repoRoot) ? [] : [gitCommonDir]),
    ...(workspaceRoot === undefined ? [] : [workspaceRoot]),
  ];
  const rootOf = (path: string) =>
    roots.filter((root) => isWithin(path, root)).sort((first, second) => second.length - first.length)[0];
  const candidates = unique([
    gitCommonDir,
    gitDirOf(workspace, gitCommonDir),
    ...leaves.flatMap((leaf) => {
      const root = rootOf(leaf);

      return root === undefined ? [] : ancestorsBelow(leaf, root);
    }),
  ]).filter((path) => !roots.includes(path) && rootOf(path) !== undefined);
  const real = await Promise.all(
    candidates.map(async (path) => (await lstatOrUndefined(path))?.isDirectory()),
  );
  const kept = candidates.filter((_, index) => real[index] === true);
  const guarded = kept.find((path) => guard(path) !== undefined);

  if (guarded !== undefined) {
    throw gitRefusal(guarded, `may not be mounted (${guard(guarded)})`);
  }

  return kept.sort(byDepth);
};

const configFilesIn = async (workspace: Workspace, gitCommonDir: string, context: GitProtectContext) => {
  const gitDirs = [...new Set([gitCommonDir, gitDirOf(workspace, gitCommonDir)])];
  const outer = context.workspace;
  const listing = gitConfigFiles(workspace.repoRoot, gitDirs, context.runner, context.emptyHooksDir);
  const files = outer === undefined ? await listing.catch((): string[] => []) : await listing;
  const refused = outer === undefined ? undefined : files.find((file) => outsideNestedRepos(outer, file));

  if (refused !== undefined) {
    throw workspaceConfigRefusal(refused);
  }

  const dirs = outer === undefined ? [workspace.repoRoot, ...gitDirs] : nestedRepoDirs(outer);

  return files.filter((file) => dirs.some((dir) => isWithin(file, dir)));
};

const rootGitFile = (workspace: Workspace, gitCommonDir: string) => {
  const dotGit = join(workspace.repoRoot, ".git");

  return gitDirOf(workspace, gitCommonDir) === dotGit ? [] : [dotGit];
};

export const findProtectedGitPaths = async (
  workspace: Workspace,
  gitCommonDir: string,
  context: GitProtectContext,
  knownModules?: string[],
): Promise<ProtectedGitPaths> => {
  const modules = knownModules ?? (await findModuleGitDirs(gitCommonDir));
  const worktrees = await findWorktreeGitDirs(gitCommonDir);
  const hooksPath = await hooksPathDirs(workspace, gitCommonDir, context);
  const configFiles = await configFilesIn(workspace, gitCommonDir, context);
  const pins = [gitCommonDir, ...modules].map((dir) => join(dir, "commondir"));
  const dirs = unique([
    join(gitCommonDir, "hooks"),
    ...hooksPath,
    ...modules.map((dir) => join(dir, "hooks")),
  ]);
  const files = unique([
    join(gitCommonDir, "config"),
    join(gitCommonDir, "config.worktree"),
    ...modules.flatMap((dir) => [join(dir, "config"), join(dir, "config.worktree")]),
    ...worktrees.flatMap((dir) => WORKTREE_FILES.map((name) => join(dir, name))),
    ...rootGitFile(workspace, gitCommonDir),
    ...configFiles,
  ]).filter((path) => !pins.includes(path));
  const workspaceRoot = context.workspace?.repoRoot;

  return workspaceRoot === undefined
    ? { gitCommonDir, modules, dirs, pins, files }
    : { gitCommonDir, modules, dirs, pins, files, workspaceRoot };
};

export const protectedGitOverlay = async (
  workspace: Workspace,
  paths: ProtectedGitPaths,
  guard: GitPathGuard,
): Promise<GitOverlay> => {
  await Promise.all(paths.dirs.map((dir) => checkedLeaf(dir, "dir", guard)));

  await Promise.all(paths.pins.map((pin) => checkedLeaf(pin, "file", guard)));

  const present = await Promise.all(paths.files.map((file) => checkedLeaf(file, "file", guard)));
  const readOnlyFiles = [...paths.files.filter((_, index) => present[index]), ...paths.pins];

  return {
    selfBinds: await selfBindsOf(
      [...paths.dirs, ...readOnlyFiles],
      workspace,
      paths.gitCommonDir,
      guard,
      paths.workspaceRoot,
    ),
    readOnlyDirs: paths.dirs,
    readOnlyFiles,
  };
};
