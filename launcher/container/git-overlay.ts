import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { resolveDockerSocket } from "../backend/index.ts";
import {
  type CommandRunner,
  errorMessage,
  expandHome,
  isWithin,
  lstatOrUndefined,
  readJsonFile,
  stateLayout,
  writeJsonFile,
} from "../shared/index.ts";
import {
  assertGitIntegrity,
  findModuleGitDirs,
  findWorktreeGitDirs,
  type GitBaseline,
  gitAlternatesNotices,
  gitDirOf,
  gitRefusal,
  inertGitOptions,
  nestedGitNotices,
  pinGitDirs,
  protectedPathGuard,
  scanGitBaseline,
  unpinGitDirs,
  type Workspace,
  withGitPinLock,
} from "../workspace/index.ts";
import { gitSnapshotsDir, writeGitSnapshots } from "./git-snapshot.ts";
import { repoHash } from "./names.ts";

export interface GitOverlay {
  selfBinds: string[];
  readOnlyDirs: string[];
  readOnlyFiles: string[];
}

export interface GitGuardContext {
  runner: CommandRunner;
  home: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}

interface SessionRecord {
  scan: GitBaseline;
  alternates: string[];
}

type Guard = (path: string) => string | undefined;

const EMPTY: GitOverlay = { selfBinds: [], readOnlyDirs: [], readOnlyFiles: [] };

const WORKTREE_FILES = ["commondir", "gitdir", "config.worktree"];

const unique = (paths: string[]) => [...new Set(paths)];

const byDepth = (first: string, second: string) =>
  first.split(sep).length - second.split(sep).length || first.localeCompare(second);

const pathsOf = (stateDir: string, repoRoot: string) => {
  const layout = stateLayout(stateDir);
  const hash = repoHash(repoRoot);

  return { noHooks: layout.gitNoHooks, record: layout.gitBaseline(hash) };
};

const realOrPending = (path: string): Promise<string> =>
  realpath(path).catch(() => {
    const parent = dirname(path);

    return parent === path ? path : realOrPending(parent).then((real) => join(real, basename(path)));
  });

const configuredHooksPath = async (workspace: Workspace, context: GitGuardContext) => {
  const { noHooks } = pathsOf(context.stateDir, workspace.repoRoot);
  const args = [...inertGitOptions(noHooks), "config", "--show-scope", "--get-all", "core.hooksPath"];
  const result = await context.runner.run("git", args, { cwd: workspace.cwd }).catch(() => undefined);
  const lines = result?.code === 0 ? result.stdout.split("\n") : [];
  const values = lines.flatMap((line) => {
    const tab = line.indexOf("\t");

    return tab > 0 && line.slice(0, tab) !== "command" && line.length > tab + 1 ? [line.slice(tab + 1)] : [];
  });

  return values.at(-1);
};

const hooksPathDirs = async (workspace: Workspace, gitCommonDir: string, context: GitGuardContext) => {
  const value = await configuredHooksPath(workspace, context);

  if (value === undefined) {
    return [];
  }

  const roots = [workspace.repoRoot, gitCommonDir];
  const lexical = resolve(workspace.repoRoot, expandHome(value, context.home));
  const real = await realOrPending(lexical);

  if (!roots.some((root) => isWithin(real, root))) {
    return [];
  }

  if (roots.some((root) => isWithin(lexical, root)) && real !== lexical) {
    throw gitRefusal(lexical, "(core.hooksPath) goes through a symbolic link the sandbox could repoint");
  }

  if (roots.includes(real) || isWithin(gitCommonDir, real)) {
    throw gitRefusal(real, "(core.hooksPath) is the repository or holds its git dir and cannot be read-only");
  }

  return [real];
};

const guardOf = (workspace: Workspace, context: GitGuardContext): Guard =>
  protectedPathGuard({
    home: context.home,
    env: context.env,
    repoRoot: workspace.repoRoot,
    engineSockets: [resolveDockerSocket({ env: context.env, home: context.home })],
  });

const checkedLeaf = async (path: string, kind: "file" | "dir", guard: Guard) => {
  const info = await lstatOrUndefined(path);

  if (info?.isSymbolicLink() === true) {
    throw gitRefusal(path, "is a symbolic link");
  }

  if (info !== undefined && (kind === "dir" ? !info.isDirectory() : !info.isFile())) {
    throw gitRefusal(path, kind === "dir" ? "is not a directory" : "is not a regular file");
  }

  if ((await realOrPending(path)) !== path) {
    throw gitRefusal(path, "goes through a symbolic link");
  }

  const reason = guard(path);

  if (reason !== undefined) {
    throw gitRefusal(path, `may not be mounted (${reason})`);
  }

  return info !== undefined;
};

const ancestorsBelow = (path: string, root: string) => {
  const parts = relative(root, path).split(sep);

  return parts.slice(0, -1).map((_, index) => join(root, ...parts.slice(0, index + 1)));
};

const selfBindsOf = async (leaves: string[], workspace: Workspace, gitCommonDir: string, guard: Guard) => {
  const roots = isWithin(gitCommonDir, workspace.repoRoot)
    ? [workspace.repoRoot]
    : [workspace.repoRoot, gitCommonDir];
  const rootOf = (path: string) =>
    roots.filter((root) => isWithin(path, root)).sort((first, second) => second.length - first.length)[0];
  const candidates = unique([
    gitCommonDir,
    gitDirOf(workspace) ?? gitCommonDir,
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

const rootGitFile = (workspace: Workspace) => {
  const dotGit = join(workspace.repoRoot, ".git");

  return gitDirOf(workspace) === dotGit ? [] : [dotGit];
};

export const discoverGitOverlay = async (
  workspace: Workspace,
  context: GitGuardContext,
): Promise<GitOverlay> => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return EMPTY;
  }

  const modules = await findModuleGitDirs(gitCommonDir);
  const worktrees = await findWorktreeGitDirs(gitCommonDir);
  const pins = [gitCommonDir, ...modules].map((dir) => join(dir, "commondir"));
  const dirs = unique([
    join(gitCommonDir, "hooks"),
    ...(await hooksPathDirs(workspace, gitCommonDir, context)),
    ...modules.map((dir) => join(dir, "hooks")),
  ]);
  const files = unique([
    join(gitCommonDir, "config"),
    join(gitCommonDir, "config.worktree"),
    ...modules.flatMap((dir) => [join(dir, "config"), join(dir, "config.worktree")]),
    ...worktrees.flatMap((dir) => WORKTREE_FILES.map((name) => join(dir, name))),
    ...rootGitFile(workspace),
  ]).filter((path) => !pins.includes(path));
  const guard = guardOf(workspace, context);

  await Promise.all(dirs.map((dir) => checkedLeaf(dir, "dir", guard)));

  await Promise.all(pins.map((pin) => checkedLeaf(pin, "file", guard)));

  const present = await Promise.all(files.map((file) => checkedLeaf(file, "file", guard)));
  const readOnlyFiles = [...files.filter((_, index) => present[index]), ...pins];

  return {
    selfBinds: await selfBindsOf([...dirs, ...readOnlyFiles], workspace, gitCommonDir, guard),
    readOnlyDirs: dirs,
    readOnlyFiles,
  };
};

export const readyGitOverlay = async (
  workspace: Workspace,
  context: GitGuardContext,
): Promise<GitOverlay> => {
  if (workspace.gitCommonDir === undefined) {
    return EMPTY;
  }

  await assertGitIntegrity(workspace);

  await pinGitDirs(workspace);

  const pending = await discoverGitOverlay(workspace, context);

  await Promise.all(
    pending.readOnlyDirs.map((dir) => mkdir(dir, { recursive: true }).catch(() => undefined)),
  );

  const overlay = await discoverGitOverlay(workspace, context);
  const paths = pathsOf(context.stateDir, workspace.repoRoot);

  await writeGitSnapshots(overlay, gitSnapshotsDir(context.stateDir, workspace.repoRoot));

  const record: SessionRecord = {
    scan: await scanGitBaseline(workspace, context.runner, paths.noHooks),
    alternates: await gitAlternatesNotices(workspace),
  };

  await writeJsonFile(paths.record, record);

  return overlay;
};

export const gitLaunchNotices = async (workspace: Workspace) => {
  await assertGitIntegrity(workspace);

  return gitAlternatesNotices(workspace);
};

const scanNotices = async (workspace: Workspace, context: GitGuardContext, record: SessionRecord) => {
  const { noHooks } = pathsOf(context.stateDir, workspace.repoRoot);

  return nestedGitNotices(record.scan, await scanGitBaseline(workspace, context.runner, noHooks));
};

export const gitSessionEndNotices = async (
  workspace: Workspace,
  context: GitGuardContext,
  pinsInUse: () => Promise<boolean>,
) => {
  if (workspace.gitCommonDir === undefined) {
    return [];
  }

  const unpinned = await withGitPinLock(context.stateDir, workspace, async () =>
    (await pinsInUse()) ? [] : unpinGitDirs(workspace),
  );
  const broken = await assertGitIntegrity(workspace).then(
    () => [],
    (error: unknown) => [errorMessage(error)],
  );
  const record = await readJsonFile<SessionRecord>(
    pathsOf(context.stateDir, workspace.repoRoot).record,
  ).catch(() => undefined);
  const alternates = (await gitAlternatesNotices(workspace)).filter(
    (notice) => !(record?.alternates ?? []).includes(notice),
  );
  const scanned =
    record === undefined || broken.length > 0 ? [] : await scanNotices(workspace, context, record);

  return [...unpinned, ...broken, ...alternates, ...scanned];
};
