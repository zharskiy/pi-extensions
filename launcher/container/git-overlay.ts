import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  byDepth,
  createWorktreeConfigs,
  dirsBetween,
  findProtectedGitPaths,
  type GitOverlay,
  type GitPathGuard,
  type GitProtectContext,
  gitPathGuard,
  gitRepos,
  type ProtectedGitPaths,
  pinGitDirs,
  protectedGitOverlay,
  protectedWorkspaceOverlay,
  recordGitBaseline,
  unique,
  type Workspace,
} from "../workspace/index.ts";
import { isGitConfigFile } from "./spec.ts";

export type { GitOverlay } from "../workspace/index.ts";

export interface GitGuardContext {
  runner: CommandRunner;
  home: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  volumePaths?: string[];
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
  emptyHooksDir: stateLayout(context.stateDir).emptyDir,
  engineSockets: [engineSocketPath(context.home)],
});

const sameList = (first: string[], second: string[]) =>
  first.length === second.length && first.every((entry, index) => entry === second[index]);

interface Recorder {
  pin(path: string, gitCommonDir: string): Promise<void>;
  dirs(paths: string[], gitCommonDir: string): Promise<void>;
}

const recorderOf = (stateDir: string, owner: string): Recorder => ({
  pin: (path, gitCommonDir) => recordPins(stateDir, owner, [{ path, gitCommonDir }]),
  dirs: (paths, gitCommonDir) => recordCreatedDirs(stateDir, owner, paths, { gitCommonDir }),
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

const combined = (overlays: GitOverlay[]): GitOverlay => ({
  selfBinds: unique(overlays.flatMap((overlay) => overlay.selfBinds)).sort(byDepth),
  readOnlyDirs: unique(overlays.flatMap((overlay) => overlay.readOnlyDirs)),
  readOnlyFiles: unique(overlays.flatMap((overlay) => overlay.readOnlyFiles)),
});

const merged = (workspace: Workspace, outer: GitOverlay, overlays: GitOverlay[]): GitOverlay => {
  const [single] = overlays;

  return workspace.isGitRepo && single !== undefined ? single : combined([outer, ...overlays]);
};

const outerOverlay = (workspace: Workspace, protect: GitProtectContext) =>
  workspace.isGitRepo
    ? Promise.resolve(EMPTY)
    : protectedWorkspaceOverlay(workspace, gitPathGuard(workspace, protect));

interface RepoPlan {
  overlay: GitOverlay;
  ready(recorder: Recorder): Promise<GitOverlay>;
}

const createdChain = (first: string | undefined, dir: string) =>
  first === undefined ? [] : [first, ...dirsBetween(first, dir)];

const createDir = async (dir: string, recorder: Recorder, gitCommonDir: string) => {
  await recorder.dirs(
    createdChain(await mkdir(dir, { recursive: true }).catch(() => undefined), dir),
    gitCommonDir,
  );
};

const readiedRepo = async (
  repo: Workspace,
  protect: GitProtectContext,
  guard: GitPathGuard,
  discovered: ProtectedGitPaths,
  recorder: Recorder,
) => {
  const paths = await pinned(repo, discovered, protect, recorder);

  await Promise.all(paths.dirs.map((dir) => createDir(dir, recorder, paths.gitCommonDir)));

  return protectedGitOverlay(repo, paths, guard);
};

const plannedPaths = async (repo: Workspace, gitCommonDir: string, protect: GitProtectContext) => {
  const found = await findProtectedGitPaths(repo, gitCommonDir, protect);

  return (await createWorktreeConfigs(found)) ? findProtectedGitPaths(repo, gitCommonDir, protect) : found;
};

const repoPlan = async (
  repo: Workspace,
  gitCommonDir: string,
  protect: GitProtectContext,
): Promise<RepoPlan> => {
  const guard = gitPathGuard(repo, protect);
  const paths = await plannedPaths(repo, gitCommonDir, protect);

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

const readied = async (
  workspace: Workspace,
  context: GitGuardContext,
  plans: RepoPlan[],
  outer: () => Promise<GitOverlay>,
) => {
  const owner = repoHash(workspace.repoRoot);
  const recorder = recorderOf(context.stateDir, owner);
  const outcomes = await Promise.allSettled(plans.map((plan) => plan.ready(recorder)));
  const failed = outcomes.find((outcome) => outcome.status === "rejected");

  if (failed !== undefined) {
    throw failed.reason;
  }

  const overlay = merged(
    workspace,
    await outer(),
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

  if (repos.length === 0 && workspace.isGitRepo) {
    return NO_GIT_PLAN;
  }

  const protect = workspace.isGitRepo ? protectContext(context) : { ...protectContext(context), workspace };
  const outer = () => outerOverlay(workspace, protect);

  if (repos.length === 0) {
    return { overlay: await outer(), ready: outer };
  }

  const plans = await Promise.all(
    repos.map(({ repo, gitCommonDir }) => repoPlan(repo, gitCommonDir, protect)),
  );

  return {
    overlay: merged(
      workspace,
      await outer(),
      plans.map((plan) => plan.overlay),
    ),
    ready: () => readied(workspace, context, plans, outer),
  };
};
