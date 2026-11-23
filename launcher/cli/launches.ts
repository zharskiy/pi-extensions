import type { Backend } from "../backend/index.ts";
import { removeLaunchContainer } from "../container/index.ts";
import { endLaunch, type Launch, newLaunchId, othersLive, registerLaunch } from "../grants/index.ts";
import { errorMessage, processMark, writeRepoRecord } from "../shared/index.ts";
import type { LaunchContext } from "./context.ts";
import { type CliDeps, writeLine } from "./deps.ts";
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
    await writeRepoRecord(
      context.stateDir,
      context.repoHash,
      context.workspace.repoRoot,
      context.mountedRoot,
    );

    await registerLaunch(context.stateDir, launch);
  });

  return launch;
};

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

    await removeRepoSandbox(deps, context.repoHash, backend);

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
