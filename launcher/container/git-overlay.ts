import { mkdir } from "node:fs/promises";
import { errorMessage, LauncherError } from "../shared/index.ts";
import {
  assertGitIntegrity,
  byDepth,
  findProtectedGitPaths,
  type GitLaunchContext,
  type GitOverlay,
  gitRepos,
  type ProtectedGitPaths,
  protectedGitOverlay,
  protectedWorkspaceOverlay,
  recordGitBaseline,
  unique,
  type Workspace,
} from "../workspace/index.ts";

export type { GitOverlay } from "../workspace/index.ts";

export type GitGuardContext = GitLaunchContext;

interface ReadyOptions {
  othersLive?: boolean;
}

export interface GitPlan {
  overlay: GitOverlay;
  ready(options?: ReadyOptions): Promise<GitOverlay>;
  pendingNotices(): string[];
}

const EMPTY: GitOverlay = { selfBinds: [], readOnlyDirs: [] };

const NO_GIT_PLAN: GitPlan = { overlay: EMPTY, ready: async () => EMPTY, pendingNotices: () => [] };

const sameList = (first: string[], second: string[]) =>
  first.length === second.length && first.every((entry, index) => entry === second[index]);

const combined = (overlays: GitOverlay[]): GitOverlay => ({
  selfBinds: unique(overlays.flatMap((overlay) => overlay.selfBinds)).sort(byDepth),
  readOnlyDirs: unique(overlays.flatMap((overlay) => overlay.readOnlyDirs)),
});

const merged = (workspace: Workspace, outer: GitOverlay, overlays: GitOverlay[]): GitOverlay => {
  const [single] = overlays;

  return workspace.isGitRepo && single !== undefined ? single : combined([outer, ...overlays]);
};

const outerOverlay = (workspace: Workspace) =>
  workspace.isGitRepo ? Promise.resolve(EMPTY) : protectedWorkspaceOverlay(workspace);

const uncreatable = (dir: string, error: unknown) =>
  new LauncherError(
    `git: ${dir} could not be created as a hooks dir (${(error as NodeJS.ErrnoException).code ?? errorMessage(error)}), so it cannot be bound read-only`,
    "create it as a directory",
  );

const createHooksDir = async (dir: string) => {
  await mkdir(dir, { recursive: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw uncreatable(dir, error);
    }
  });
};

const firstFailure = (outcomes: PromiseSettledResult<unknown>[]) => {
  const failed = outcomes.find((outcome) => outcome.status === "rejected");

  if (failed !== undefined) {
    throw failed.reason;
  }
};

const readiedRepo = async (repo: Workspace, discovered: ProtectedGitPaths) => {
  const modules = await assertGitIntegrity(repo);
  const paths = sameList(modules, discovered.modules)
    ? discovered
    : await findProtectedGitPaths(discovered.gitCommonDir, discovered.workspaceRoot, modules);

  firstFailure(await Promise.allSettled(paths.hooksDirs.map(createHooksDir)));

  return protectedGitOverlay(repo, paths);
};

interface RepoPlan {
  overlay: GitOverlay;
  ready(): Promise<GitOverlay>;
}

const repoPlan = async (repo: Workspace, gitCommonDir: string, workspaceRoot?: string): Promise<RepoPlan> => {
  const paths = await findProtectedGitPaths(gitCommonDir, workspaceRoot);

  return { overlay: await protectedGitOverlay(repo, paths), ready: () => readiedRepo(repo, paths) };
};

interface Readied {
  overlay: GitOverlay;
  pending: string[];
}

const readied = async (
  workspace: Workspace,
  context: GitGuardContext,
  plans: RepoPlan[],
  options: ReadyOptions,
): Promise<Readied> => {
  const outcomes = await Promise.allSettled(plans.map((plan) => plan.ready()));

  firstFailure(outcomes);

  const overlay = merged(
    workspace,
    await outerOverlay(workspace),
    outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : [])),
  );

  return { overlay, pending: await recordGitBaseline(workspace, context, options.othersLive === true) };
};

const withPending = (overlay: GitOverlay, ready: (options: ReadyOptions) => Promise<Readied>): GitPlan => {
  const last = { pending: [] as string[] };

  return {
    overlay,
    ready: async (options = {}) => {
      const done = await ready(options);

      last.pending = done.pending;

      return done.overlay;
    },
    pendingNotices: () => last.pending,
  };
};

export const planGitOverlay = async (workspace: Workspace, context: GitGuardContext): Promise<GitPlan> => {
  const repos = gitRepos(workspace).flatMap((repo) =>
    repo.gitCommonDir === undefined ? [] : [{ repo, gitCommonDir: repo.gitCommonDir }],
  );

  if (repos.length === 0 && workspace.isGitRepo) {
    return NO_GIT_PLAN;
  }

  const workspaceRoot = workspace.isGitRepo ? undefined : workspace.repoRoot;
  const plans = await Promise.all(
    repos.map(({ repo, gitCommonDir }) => repoPlan(repo, gitCommonDir, workspaceRoot)),
  );

  return withPending(
    merged(
      workspace,
      await outerOverlay(workspace),
      plans.map((plan) => plan.overlay),
    ),
    (options) => readied(workspace, context, plans, options),
  );
};
