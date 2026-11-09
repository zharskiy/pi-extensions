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

interface Recorder {
  pin(path: string, gitCommonDir: string): Promise<void>;
  dirs(paths: string[]): Promise<void>;
}

const recorderOf = (stateDir: string, owner: string): Recorder => ({
  pin: (path, gitCommonDir) => recordPins(stateDir, owner, [{ path, gitCommonDir }]),
  dirs: (paths) => recordCreatedDirs(stateDir, owner, paths),
});

const pinned = async (
  workspace: Workspace,
  paths: ProtectedGitPaths,
  context: GitProtectContext,
  recorder: Recorder,
) => {
  const onPin = (path: string) => recorder.pin(path, paths.gitCommonDir);

  await pinGitDirs(workspace, paths.modules, onPin);

  const modules = await assertGitIntegrity(workspace);

  if (sameList(modules, paths.modules)) {
    return paths;
  }

  const current = await findProtectedGitPaths(workspace, paths.gitCommonDir, context, modules);

  await pinGitDirs(workspace, current.modules, onPin);

  await assertGitIntegrity(workspace);

  return current;
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

interface RepoPlan {
  overlay: GitOverlay;
  ready(recorder: Recorder): Promise<GitOverlay>;
}

const createdChain = (first: string | undefined, dir: string): string[] => {
  if (first === undefined) {
    return [];
  }

  return dir === first || dirname(dir) === dir ? [dir] : [...createdChain(first, dirname(dir)), dir];
};

const createDir = async (dir: string, recorder: Recorder) => {
  await recorder.dirs(createdChain(await mkdir(dir, { recursive: true }).catch(() => undefined), dir));
};

const readiedRepo = async (
  repo: Workspace,
  protect: GitProtectContext,
  guard: GitPathGuard,
  discovered: ProtectedGitPaths,
  recorder: Recorder,
) => {
  const paths = await pinned(repo, discovered, protect, recorder);

  await Promise.all(paths.dirs.map((dir) => createDir(dir, recorder)));

  return protectedGitOverlay(repo, paths, guard);
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
    ready: (recorder) => readiedRepo(repo, protect, guard, paths, recorder),
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
  const recorder = recorderOf(context.stateDir, owner);
  const outcomes = await Promise.allSettled(plans.map((plan) => plan.ready(recorder)));
  const failed = outcomes.find((outcome) => outcome.status === "rejected");

  if (failed !== undefined) {
    throw failed.reason;
  }

  const overlay = merged(
    workspace,
    outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : [])),
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
