import { mkdir } from "node:fs/promises";
import { sep } from "node:path";
import { engineSocketPath } from "../backend/index.ts";
import { type CommandRunner, stateLayout } from "../shared/index.ts";
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
import { gitSnapshotsDir, writeGitSnapshots } from "./git-snapshot.ts";

export type { GitOverlay } from "../workspace/index.ts";

export { gitLaunchNotices, gitSessionEndNotices } from "../workspace/index.ts";

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
  await pinGitDirs(workspace, paths.modules);

  const modules = await assertGitIntegrity(workspace);

  if (sameList(modules, paths.modules)) {
    return paths;
  }

  const current = await findProtectedGitPaths(workspace, paths.gitCommonDir, context, modules);

  await pinGitDirs(workspace, current.modules);

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
  ready(): Promise<GitOverlay>;
}

const readiedRepo = async (
  repo: Workspace,
  protect: GitProtectContext,
  guard: GitPathGuard,
  discovered: ProtectedGitPaths,
) => {
  const paths = await pinned(repo, discovered, protect);

  await Promise.all(paths.dirs.map((dir) => mkdir(dir, { recursive: true }).catch(() => undefined)));

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
    ready: () => readiedRepo(repo, protect, guard, paths),
  };
};

const readied = async (workspace: Workspace, context: GitGuardContext, plans: RepoPlan[]) => {
  const overlay = merged(workspace, await Promise.all(plans.map((plan) => plan.ready())));

  await writeGitSnapshots(overlay, gitSnapshotsDir(context.stateDir, workspace.repoRoot));

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
