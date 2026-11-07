import { mkdir } from "node:fs/promises";
import { resolveDockerSocket } from "../backend/index.ts";
import { type CommandRunner, stateLayout } from "../shared/index.ts";
import {
  assertGitIntegrity,
  findProtectedGitPaths,
  type GitOverlay,
  type GitPathGuard,
  type GitProtectContext,
  gitPathGuard,
  type ProtectedGitPaths,
  pinGitDirs,
  protectedGitOverlay,
  recordGitBaseline,
  type Workspace,
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

const UNPROTECTED: GitPlan = { overlay: EMPTY, ready: async () => EMPTY };

const protectContext = (context: GitGuardContext): GitProtectContext => ({
  runner: context.runner,
  home: context.home,
  env: context.env,
  emptyHooksDir: stateLayout(context.stateDir).gitNoHooks,
  engineSockets: [resolveDockerSocket({ env: context.env, home: context.home })],
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

const readied = async (
  workspace: Workspace,
  context: GitGuardContext,
  protect: GitProtectContext,
  guard: GitPathGuard,
  discovered: ProtectedGitPaths,
) => {
  const paths = await pinned(workspace, discovered, protect);

  await Promise.all(paths.dirs.map((dir) => mkdir(dir, { recursive: true }).catch(() => undefined)));

  const overlay = await protectedGitOverlay(workspace, paths, guard);

  await writeGitSnapshots(overlay, gitSnapshotsDir(context.stateDir, workspace.repoRoot));

  await recordGitBaseline(workspace, context);

  return overlay;
};

export const planGitOverlay = async (workspace: Workspace, context: GitGuardContext): Promise<GitPlan> => {
  const gitCommonDir = workspace.gitCommonDir;

  if (gitCommonDir === undefined) {
    return UNPROTECTED;
  }

  const protect = protectContext(context);
  const guard = gitPathGuard(workspace, protect);
  const paths = await findProtectedGitPaths(workspace, gitCommonDir, protect);

  return {
    overlay: await protectedGitOverlay(workspace, paths, guard),
    ready: () => readied(workspace, context, protect, guard, paths),
  };
};

export const discoverGitOverlay = async (workspace: Workspace, context: GitGuardContext) =>
  (await planGitOverlay(workspace, context)).overlay;

export const readyGitOverlay = async (workspace: Workspace, context: GitGuardContext) =>
  (await planGitOverlay(workspace, context)).ready();
