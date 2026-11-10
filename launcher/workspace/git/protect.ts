import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type CommandRunner,
  expandHome,
  isWithin,
  LauncherError,
  lstatOrUndefined,
} from "../../shared/index.ts";
import { protectedRealPathGuard } from "../mounts.ts";
import { byDepth, dirsBetween, realOrPending, unique } from "../paths.ts";
import { gitRepos, type Workspace } from "../types.ts";
import {
  type ConfigSource,
  configClosure,
  configFilesOf,
  type GitConfigListing,
  type HooksPathValue,
  isForeignPath,
  missingInclude,
  missingWorktreeConfig,
  readGitConfig,
} from "./config.ts";
import {
  findModuleGitDirs,
  findWorktreeGitDirs,
  gitRefusal,
  lstatKind,
  pointerPath,
  readGitPointer,
} from "./layout.ts";
import {
  nestedRepoDirs,
  outsideNestedRepos,
  ownConfigFiles,
  workspaceConfigRefusal,
  workspaceSelfBinds,
} from "./workspace.ts";

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
  required: RequiredFile[];
  workspaceRoot?: string;
}

interface RequiredFile {
  path: string;
  includedBy?: string;
}

export type GitPathGuard = (path: string) => string | undefined;

const WORKTREE_FILES = ["commondir", "gitdir", "config.worktree"];

const gitConfigOf = (workspace: Workspace, context: GitProtectContext): Promise<GitConfigListing> =>
  workspace.gitConfig !== undefined
    ? Promise.resolve(workspace.gitConfig)
    : readGitConfig(workspace.repoRoot, context.runner, context.emptyHooksDir, {
        home: context.home,
        ...(context.workspace === undefined ? { withoutGit: "empty" as const } : {}),
      });

const mountedRoots = (workspace: Workspace, gitCommonDir: string, context: GitProtectContext) => [
  workspace.repoRoot,
  gitCommonDir,
  ...(context.workspace === undefined ? [] : [context.workspace.repoRoot]),
];

const worktreeRootOf = async (worktreeGitDir: string) => {
  const text = await readGitPointer(join(worktreeGitDir, "gitdir"));

  if (text === undefined) {
    return undefined;
  }

  const dotGit = pointerPath(worktreeGitDir, text);

  return (await lstatOrUndefined(dotGit)) === undefined ? undefined : realOrPending(dirname(dotGit));
};

const checkoutRoots = (worktrees: string[]) => Promise.all(worktrees.map(worktreeRootOf));

const checkedHooksDir = async (
  workspace: Workspace,
  gitCommonDir: string,
  lexical: string,
  context: GitProtectContext,
) => {
  const outer = context.workspace;
  const roots = mountedRoots(workspace, gitCommonDir, context);
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

const hooksPathCandidates = (value: HooksPathValue, checkouts: string[], home: string) => {
  if (isForeignPath(value.value)) {
    return [];
  }

  const expanded = expandHome(value.value, home);

  if (isAbsolute(expanded)) {
    return [expanded];
  }

  if (value.base === null) {
    throw gitRefusal(
      value.origin,
      `sets a relative core.hooksPath (${value.value}) but no core.worktree, so the launcher cannot tell where git runs it`,
    );
  }

  return (value.base === undefined ? checkouts : [value.base]).map((base) => resolve(base, expanded));
};

const hooksPathDirs = async (
  workspace: Workspace,
  gitCommonDir: string,
  values: HooksPathValue[],
  checkouts: string[],
  context: GitProtectContext,
) => {
  const candidates = unique(values.flatMap((value) => hooksPathCandidates(value, checkouts, context.home)));
  const dirs = await Promise.all(
    candidates.map((lexical) => checkedHooksDir(workspace, gitCommonDir, lexical, context)),
  );

  return dirs.flat();
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
    workspace.gitDir ?? gitCommonDir,
    ...leaves.flatMap((leaf) => {
      const root = rootOf(leaf);

      return root === undefined ? [] : dirsBetween(root, dirname(leaf));
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

const configFilesIn = async (
  workspace: Workspace,
  gitDirs: string[],
  listing: GitConfigListing,
  context: GitProtectContext,
) => {
  const outer = context.workspace;
  const { files, included } = await configFilesOf(listing, ownConfigFiles(gitDirs));
  const refused = outer === undefined ? undefined : files.find((file) => outsideNestedRepos(outer, file));

  if (refused !== undefined) {
    throw workspaceConfigRefusal(refused);
  }

  const dirs = outer === undefined ? [workspace.repoRoot, ...gitDirs] : nestedRepoDirs(outer);
  const writable = outer === undefined ? dirs : [outer.repoRoot, ...dirs];
  const required = included
    .filter((file) => writable.some((dir) => isWithin(file.path, dir) || isWithin(file.real, dir)))
    .map((file) => ({ path: file.path, includedBy: file.origin }));
  const within = (file: string) => dirs.some((dir) => isWithin(file, dir));

  return {
    files: [...files, ...required.map((file) => file.path)].filter(within),
    required,
  };
};

const rootGitFile = (workspace: Workspace, gitCommonDir: string) => {
  const dotGit = join(workspace.repoRoot, ".git");

  return (workspace.gitDir ?? gitCommonDir) === dotGit ? [] : [dotGit];
};

const worktreeConfigFiles = (listing: GitConfigListing, gitCommonDir: string, worktrees: string[]) =>
  listing.worktreeConfig
    ? [gitCommonDir, ...worktrees].map((dir) => ({ path: join(dir, "config.worktree") }))
    : [];

const mainCheckoutOf = (workspace: Workspace, gitCommonDir: string) => {
  if ((workspace.gitDir ?? gitCommonDir) === gitCommonDir) {
    return workspace.repoRoot;
  }

  return basename(gitCommonDir) === ".git" ? dirname(gitCommonDir) : gitCommonDir;
};

const closureSources = (
  listing: GitConfigListing,
  workspace: Workspace,
  gitCommonDir: string,
  worktrees: string[],
  checkouts: (string | undefined)[],
  modules: string[],
): ConfigSource[] => [
  ...(listing.worktreeConfig
    ? [
        { file: join(gitCommonDir, "config.worktree"), base: mainCheckoutOf(workspace, gitCommonDir) },
        ...worktrees.flatMap((dir, index) => {
          const base = checkouts[index];

          return base === undefined ? [] : [{ file: join(dir, "config.worktree"), base }];
        }),
      ]
    : []),
  ...modules.flatMap((dir) => [
    { file: join(dir, "config"), worktreeFromFile: true },
    { file: join(dir, "config.worktree"), worktreeFromFile: true },
  ]),
];

export const findProtectedGitPaths = async (
  workspace: Workspace,
  gitCommonDir: string,
  context: GitProtectContext,
  knownModules?: string[],
): Promise<ProtectedGitPaths> => {
  const gitDirs = unique([gitCommonDir, workspace.gitDir ?? gitCommonDir]);
  const listing = await gitConfigOf(workspace, context);
  const modules = knownModules ?? (await findModuleGitDirs(gitCommonDir));
  const worktrees = await findWorktreeGitDirs(gitCommonDir);
  const checkouts = await checkoutRoots(worktrees);
  const roots = mountedRoots(workspace, gitCommonDir, context);
  const closure = await configClosure(
    listing,
    closureSources(listing, workspace, gitCommonDir, worktrees, checkouts, modules),
    { runner: context.runner, emptyHooksDir: context.emptyHooksDir, home: context.home },
  );
  const hooksValues = [
    ...(listing.hooksPath === undefined
      ? []
      : [{ value: listing.hooksPath, origin: "the git configuration" }]),
    ...closure.hooksPaths,
  ];
  const linkedCheckouts = checkouts.flatMap((root) =>
    root !== undefined && roots.some((dir) => isWithin(root, dir)) ? [root] : [],
  );
  const hooksPath = await hooksPathDirs(
    workspace,
    gitCommonDir,
    hooksValues,
    unique([workspace.repoRoot, ...linkedCheckouts]),
    context,
  );
  const config = await configFilesIn(
    workspace,
    gitDirs,
    { ...listing, includes: [...listing.includes, ...closure.includes] },
    context,
  );
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
    ...config.files,
  ]).filter((path) => !pins.includes(path));
  const required = [...worktreeConfigFiles(listing, gitCommonDir, worktrees), ...config.required];
  const workspaceRoot = context.workspace?.repoRoot;

  return workspaceRoot === undefined
    ? { gitCommonDir, modules, dirs, pins, files, required }
    : { gitCommonDir, modules, dirs, pins, files, required, workspaceRoot };
};

const missingRequired = (file: RequiredFile) =>
  file.includedBy === undefined
    ? missingWorktreeConfig(file.path)
    : missingInclude({ origin: file.includedBy, path: file.path });

const assertRequiredPresent = async (required: RequiredFile[]) => {
  const kinds = await Promise.all(required.map((file) => lstatKind(file.path, "file")));
  const missing = required.find((_, index) => kinds[index] === "missing");

  if (missing !== undefined) {
    throw missingRequired(missing);
  }
};

export const protectedGitOverlay = async (
  workspace: Workspace,
  paths: ProtectedGitPaths,
  guard: GitPathGuard,
): Promise<GitOverlay> => {
  await assertRequiredPresent(paths.required);

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

const changedWhileStarting = (path: string) =>
  new LauncherError(`workspace: ${path} changed while pi was starting, refusing`, "run pi again");

const unchangedLeaf = async (path: string, kind: "file" | "dir", guard: GitPathGuard) => {
  const info = await lstatOrUndefined(path);

  if (
    info === undefined ||
    info.isSymbolicLink() ||
    (kind === "dir" ? !info.isDirectory() : !info.isFile())
  ) {
    throw changedWhileStarting(path);
  }

  await checkedLeaf(path, kind, guard);
};

export const protectedWorkspaceOverlay = async (
  workspace: Workspace,
  guard: GitPathGuard,
): Promise<GitOverlay> => {
  const dirs = workspace.bareDirs ?? [];
  const files = (workspace.detached ?? []).map((checkout) => join(checkout.repoRoot, ".git"));

  await Promise.all([
    ...[...dirs, ...(workspace.masked ?? [])].map((dir) => unchangedLeaf(dir, "dir", guard)),
    ...files.map((file) => unchangedLeaf(file, "file", guard)),
  ]);

  return { selfBinds: workspaceSelfBinds(workspace), readOnlyDirs: dirs, readOnlyFiles: files };
};
