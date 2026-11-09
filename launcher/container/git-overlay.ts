import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { engineSocketPath } from "../backend/index.ts";
import {
  type CommandRunner,
  readRegularFile,
  recordCreatedDirs,
  recordPins,
  repoHash,
  stateLayout,
} from "../shared/index.ts";
import {
  assertGitIntegrity,
  findProtectedGitPaths,
  type GitOverlay,
  type GitPathGuard,
  type GitProtectContext,
  gitPathGuard,
  gitRepos,
  type ProtectedGitPaths,
  pinGitDirs,
  protectedGitOverlay,
  recordGitBaseline,
  type Workspace,
  workspaceSelfBinds,
} from "../workspace/index.ts";
import { isGitConfigFile } from "./spec.ts";

export type { GitOverlay } from "../workspace/index.ts";

export { gitLaunchEndNotices, gitLaunchNotices } from "../workspace/index.ts";

export interface GitGuardContext {
  runner: CommandRunner;
  home: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}

export interface GitPlan {
  overlay: GitOverlay;
  ready(): Promise<GitOverlay>;
}

const EMPTY: GitOverlay = { selfBinds: [], readOnlyDirs: [], readOnlyFiles: [] };

const NO_GIT_PLAN: GitPlan = { overlay: EMPTY, ready: async () => EMPTY };

const protectContext = (context: GitGuardContext): GitProtectContext => ({
  runner: context.runner,
  home: context.home,
  env: context.env,
  emptyHooksDir: stateLayout(context.stateDir).gitNoHooks,
  engineSockets: [engineSocketPath(context.home)],
});

const sameList = (first: string[], second: string[]) =>
  first.length === second.length && first.every((entry, index) => entry === second[index]);

const pinned = async (workspace: Workspace, paths: ProtectedGitPaths, context: GitProtectContext) => {
  const first = await pinGitDirs(workspace, paths.modules);
  const modules = await assertGitIntegrity(workspace);

  if (sameList(modules, paths.modules)) {
    return { paths, pins: first };
  }

  const current = await findProtectedGitPaths(workspace, paths.gitCommonDir, context, modules);
  const second = await pinGitDirs(workspace, current.modules);

  await assertGitIntegrity(workspace);

  return { paths: current, pins: [...first, ...second] };
};

const depthOf = (path: string) => path.split(sep).length;

const byDepth = (left: string, right: string) => depthOf(left) - depthOf(right) || left.localeCompare(right);

const unique = (paths: string[]) => [...new Set(paths)];

const combined = (workspace: Workspace, overlays: GitOverlay[]): GitOverlay => ({
  selfBinds: unique([
    ...workspaceSelfBinds(workspace),
    ...overlays.flatMap((overlay) => overlay.selfBinds),
  ]).sort(byDepth),
  readOnlyDirs: unique(overlays.flatMap((overlay) => overlay.readOnlyDirs)),
  readOnlyFiles: unique(overlays.flatMap((overlay) => overlay.readOnlyFiles)),
});

const merged = (workspace: Workspace, overlays: GitOverlay[]): GitOverlay => {
  const [single] = overlays;

  return workspace.isGitRepo && single !== undefined ? single : combined(workspace, overlays);
};

interface ReadyRepo {
  overlay: GitOverlay;
  pins: string[];
  gitCommonDir: string;
  created: string[];
}

interface RepoPlan {
  overlay: GitOverlay;
  ready(): Promise<ReadyRepo>;
}

const createdChain = (first: string | undefined, dir: string): string[] => {
  if (first === undefined) {
    return [];
  }

  return dir === first || dirname(dir) === dir ? [dir] : [...createdChain(first, dirname(dir)), dir];
};

const createDir = async (dir: string) =>
  createdChain(await mkdir(dir, { recursive: true }).catch(() => undefined), dir);

const readiedRepo = async (
  repo: Workspace,
  protect: GitProtectContext,
  guard: GitPathGuard,
  discovered: ProtectedGitPaths,
): Promise<ReadyRepo> => {
  const { paths, pins } = await pinned(repo, discovered, protect);
  const created = await Promise.all(paths.dirs.map(createDir));

  return {
    overlay: await protectedGitOverlay(repo, paths, guard),
    pins,
    gitCommonDir: paths.gitCommonDir,
    created: created.flat(),
  };
};

const repoPlan = async (
  repo: Workspace,
  gitCommonDir: string,
  protect: GitProtectContext,
): Promise<RepoPlan> => {
  const guard = gitPathGuard(repo, protect);
  const paths = await findProtectedGitPaths(repo, gitCommonDir, protect);

  return {
    overlay: await protectedGitOverlay(repo, paths, guard),
    ready: () => readiedRepo(repo, protect, guard, paths),
  };
};

const MODE_BITS = 0o777;

const copyGitConfig = async (stateDir: string, owner: string, path: string) => {
  const { data, mode } = await readRegularFile(path);
  const copy = stateLayout(stateDir).repo(owner).gitCopy(path);

  await mkdir(dirname(copy), { recursive: true, mode: 0o700 });

  await rm(copy, { force: true });

  await writeFile(copy, data, { mode: mode & MODE_BITS, flag: "wx" });
};

const readied = async (workspace: Workspace, context: GitGuardContext, plans: RepoPlan[]) => {
  const owner = repoHash(workspace.repoRoot);
  const repos = await Promise.all(plans.map((plan) => plan.ready()));
  const pins = repos.flatMap((repo) => repo.pins.map((path) => ({ path, gitCommonDir: repo.gitCommonDir })));

  await recordPins(context.stateDir, owner, pins);

  await recordCreatedDirs(
    context.stateDir,
    owner,
    repos.flatMap((repo) => repo.created),
  );

  const overlay = merged(
    workspace,
    repos.map((repo) => repo.overlay),
  );

  await Promise.all(
    overlay.readOnlyFiles.filter(isGitConfigFile).map((path) => copyGitConfig(context.stateDir, owner, path)),
  );

  await recordGitBaseline(workspace, context);

  return overlay;
};

export const planGitOverlay = async (workspace: Workspace, context: GitGuardContext): Promise<GitPlan> => {
  const repos = gitRepos(workspace).flatMap((repo) =>
    repo.gitCommonDir === undefined ? [] : [{ repo, gitCommonDir: repo.gitCommonDir }],
  );

  if (repos.length === 0) {
    return NO_GIT_PLAN;
  }

  const protect = workspace.isGitRepo ? protectContext(context) : { ...protectContext(context), workspace };
  const plans = await Promise.all(
    repos.map(({ repo, gitCommonDir }) => repoPlan(repo, gitCommonDir, protect)),
  );

  return {
    overlay: merged(
      workspace,
      plans.map((plan) => plan.overlay),
    ),
    ready: () => readied(workspace, context, plans),
  };
};
