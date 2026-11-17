import type { Backend } from "../backend/index.ts";
import { type GitGuardContext, overlayVolumes, removeLaunchContainer } from "../container/index.ts";
import { endLaunch, type Launch, liveLaunches, newLaunchId, registerLaunch } from "../grants/index.ts";
import { errorMessage, processMark, writeRepoRecord } from "../shared/index.ts";
import { gitLaunchEndNotices } from "../workspace/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, reachableEngine, writeNotices } from "./deps.ts";
import { sweepRepoSessions } from "./host-sessions.ts";
import { removeRepoSandbox, sweepOrphans } from "./sweep.ts";

export const beginLaunch = async (deps: CliDeps, context: LaunchContext): Promise<Launch> => {
  const launch = {
    launchId: newLaunchId(),
    ...(await processMark()),
    repoHash: context.repoHash,
    startedAt: deps.now(),
  };

  await writeRepoRecord(context.stateDir, context.repoHash, context.workspace.repoRoot);

  await registerLaunch(context.stateDir, launch);

  return launch;
};

export const gitGuardOf = (deps: CliDeps, context: LaunchContext): GitGuardContext => ({
  runner: deps.runner,
  stateDir: context.stateDir,
  volumePaths: overlayVolumes(context.workspace, context.effective.config).map((volume) => volume.path),
});

const gitEndNotices = (deps: CliDeps, context: LaunchContext) =>
  gitLaunchEndNotices(context.workspace, gitGuardOf(deps, context)).catch((error: unknown) => [
    `warning: git: the check after the session failed: ${errorMessage(error)}`,
  ]);

const removeOwnContainer = async (deps: CliDeps, engine: Backend | undefined, launch: Launch) => {
  if (engine === undefined) {
    return;
  }

  await removeLaunchContainer(engine, launch.launchId).catch((error: unknown) => {
    writeNotices(deps, [`warning: the launch's container was not removed: ${errorMessage(error)}`]);
  });
};

export const finishLaunch = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  launch: Launch,
) => {
  const last: { gitNotices?: string[] } = {};
  const engine = await reachableEngine(backend);

  await removeOwnContainer(deps, engine, launch);

  try {
    await endLaunch(context.stateDir, {
      repoHash: launch.repoHash,
      launchId: launch.launchId,
      onLast: async () => {
        try {
          await removeRepoSandbox(deps, engine, context.repoHash);
        } finally {
          last.gitNotices = await gitEndNotices(deps, context);
        }
      },
    });
  } catch (error) {
    writeNotices(deps, [`warning: could not end the launch: ${errorMessage(error)}`]);
  }

  if (last.gitNotices === undefined) {
    await sweepRepoSessions(deps, context.workspace.repoRoot, false);
  } else {
    writeNotices(deps, last.gitNotices);
  }

  await sweepOrphans(deps, engine);
};

export const busyLaunches = async (stateDir: string, except?: string) =>
  (await liveLaunches(stateDir)).filter((launch) => launch.launchId !== except).length;
