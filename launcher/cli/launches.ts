import type { Backend } from "../backend/index.ts";
import { type GitGuardContext, overlayVolumes, removeLaunchContainer } from "../container/index.ts";
import { endLaunch, type Launch, newLaunchId, othersLive, registerLaunch } from "../grants/index.ts";
import { errorMessage, processMark, writeRepoRecord } from "../shared/index.ts";
import { gitLaunchEndNotices } from "../workspace/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, writeLine, writeNotices } from "./deps.ts";
import { sweepRepoSessions } from "./host-sessions.ts";
import { whenLastOfRepo, withPrepareLock } from "./prepare.ts";
import { removeRepoSandbox, sweepOrphans } from "./sweep.ts";

export const beginLaunch = async (
  deps: CliDeps,
  context: LaunchContext,
  progress: (line: string) => void,
): Promise<Launch> => {
  const launch = {
    launchId: newLaunchId(),
    ...(await processMark()),
    repoHash: context.repoHash,
    startedAt: deps.now(),
  };
  const lock = { stateDir: context.stateDir, repoHash: context.repoHash, progress };

  await withPrepareLock(lock, async () => {
    await writeRepoRecord(context.stateDir, context.repoHash, context.workspace.repoRoot);

    await registerLaunch(context.stateDir, launch);
  });

  return launch;
};

export const gitGuardOf = (deps: CliDeps, context: LaunchContext): GitGuardContext => ({
  runner: deps.runner,
  stateDir: context.stateDir,
  volumePaths: overlayVolumes(context.workspace, context.effective.config, context.stateDir).map(
    (volume) => volume.path,
  ),
});

const gitEndNotices = (deps: CliDeps, context: LaunchContext) =>
  gitLaunchEndNotices(context.workspace, gitGuardOf(deps, context)).catch((error: unknown) => [
    `warning: git: the check after the session failed: ${errorMessage(error)}`,
  ]);

const removeOwnContainer = async (deps: CliDeps, launch: Launch, backend?: Backend) => {
  if (backend === undefined) {
    return;
  }

  await removeLaunchContainer(backend, launch.launchId).catch((error: unknown) => {
    writeLine(
      deps.stderr,
      `pi-sandbox: warning: the launch's container was not removed: ${errorMessage(error)}`,
    );
  });
};

interface Ending {
  remaining: Launch[];
  backend?: Backend;
  signal: AbortSignal;
}

const removeIfLast = async (deps: CliDeps, context: LaunchContext, ending: Ending) => {
  const { backend } = ending;
  const lock = {
    stateDir: context.stateDir,
    repoHash: context.repoHash,
    signal: ending.signal,
    progress: (line: string) => writeLine(deps.stderr, line),
  };
  const outcome = await whenLastOfRepo(lock, async () => {
    if (await othersLive(context.stateDir, context.repoHash)) {
      return false;
    }

    try {
      await removeRepoSandbox(deps, context.repoHash, backend);
    } finally {
      writeNotices(deps, await gitEndNotices(deps, context));
    }

    return true;
  });

  return !outcome.busy && outcome.value;
};

const endRepo = (deps: CliDeps, context: LaunchContext, ending: Ending) =>
  ending.remaining.some((entry) => entry.repoHash === context.repoHash)
    ? Promise.resolve(false)
    : removeIfLast(deps, context, ending);

export const finishLaunch = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  launch: Launch,
  signal: AbortSignal,
) => {
  const engine = (await backend.detect()).available ? backend : undefined;

  await removeOwnContainer(deps, launch, engine);

  const ended = await endLaunch(context.stateDir, launch.launchId)
    .then((remaining) => endRepo(deps, context, { remaining, backend: engine, signal }))
    .catch((error: unknown) => {
      writeLine(deps.stderr, `pi-sandbox: warning: could not end the launch: ${errorMessage(error)}`);

      return false;
    });

  if (!ended) {
    await sweepRepoSessions(deps, context.workspace.repoRoot, false);
  }

  await sweepOrphans(deps, backend, signal);
};
