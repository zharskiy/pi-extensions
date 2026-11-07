import type { Backend } from "../backend/index.ts";
import { findRepoContainer, stopIdleContainer } from "../container/index.ts";
import { endSession, liveSessions, newLaunchId, pruneGrants, registerSession } from "../grants/index.ts";
import { errorMessage } from "../shared/index.ts";
import { type CliDeps, writeLine } from "./deps.ts";
import type { LaunchContext } from "./launch.ts";

export interface LaunchSession {
  launchId: string;
  repoHash: string;
  startedAt: number;
}

export const beginSession = async (
  deps: CliDeps,
  context: LaunchContext,
  repoHash: string,
): Promise<LaunchSession> => {
  const session = { launchId: newLaunchId(), repoHash, startedAt: deps.now() };

  await registerSession(context.stateDir, { ...session, pid: process.pid });

  return session;
};

const stopRepoContainer = async (backend: Backend, context: LaunchContext) => {
  const container = await findRepoContainer(backend, context.workspace);

  if (container !== undefined) {
    await stopIdleContainer(backend, container.id);
  }
};

type Sweep = (full: boolean) => Promise<void>;

export const finishSession = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  session: LaunchSession,
  sweep?: Sweep,
) => {
  const last = { stopped: false };

  try {
    await endSession(context.stateDir, {
      repoHash: session.repoHash,
      launchId: session.launchId,
      onLast: async () => {
        await stopRepoContainer(backend, context);

        last.stopped = true;

        await sweep?.(true);
      },
    });
  } catch (error) {
    writeLine(deps.stderr, `pi-sandbox: warning: could not end the session: ${errorMessage(error)}`);
  }

  if (!last.stopped) {
    await sweep?.(false);
  }
};

export const liveLaunchIds = async (stateDir: string, repoHash?: string) =>
  new Set((await liveSessions(stateDir, repoHash)).map((entry) => entry.launchId));

export const pruneEndedGrants = async (deps: CliDeps, stateDir: string) =>
  pruneGrants(stateDir, { now: deps.now(), liveLaunches: await liveLaunchIds(stateDir) });

export const othersLive = async (stateDir: string, session: LaunchSession) =>
  (await liveSessions(stateDir, session.repoHash)).some((entry) => entry.launchId !== session.launchId);
