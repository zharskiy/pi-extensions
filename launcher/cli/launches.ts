import type { Backend } from "../backend/index.ts";
import {
  findRepoContainer,
  type GitGuardContext,
  gitDirInUseElsewhere,
  gitLaunchEndNotices,
} from "../container/index.ts";
import { endLaunch, type Launch, liveLaunches, newLaunchId, registerLaunch } from "../grants/index.ts";
import { errorMessage } from "../shared/index.ts";
import { type CliDeps, writeLine, writeNotices } from "./deps.ts";
import type { LaunchContext } from "./launch.ts";

export const beginLaunch = async (deps: CliDeps, context: LaunchContext): Promise<Launch> => {
  const launch = {
    launchId: newLaunchId(),
    pid: process.pid,
    repoHash: context.repoHash,
    startedAt: deps.now(),
  };

  await registerLaunch(context.stateDir, launch);

  return launch;
};

const stopRepoContainer = async (backend: Backend, context: LaunchContext) => {
  const container = await findRepoContainer(backend, context.workspace);

  if (container?.state === "running") {
    await backend.stopContainer(container.id);
  }
};

type Sweep = (full: boolean) => Promise<void>;

export const gitGuardOf = (deps: CliDeps, context: LaunchContext): GitGuardContext => ({
  runner: deps.runner,
  home: deps.home,
  env: deps.env,
  stateDir: context.stateDir,
});

const settleGit = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  const notices = await gitLaunchEndNotices(context.workspace, gitGuardOf(deps, context), (gitCommonDir) =>
    gitDirInUseElsewhere(backend, context.workspace, gitCommonDir),
  ).catch((error: unknown) => [`warning: git: the check after the session failed: ${errorMessage(error)}`]);

  writeNotices(deps, notices);
};

export const finishLaunch = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  launch: Launch,
  sweep?: Sweep,
) => {
  const last = { stopped: false };

  try {
    await endLaunch(context.stateDir, {
      repoHash: launch.repoHash,
      launchId: launch.launchId,
      onLast: async () => {
        await stopRepoContainer(backend, context);

        last.stopped = true;

        await settleGit(deps, context, backend);

        await sweep?.(true);
      },
    });
  } catch (error) {
    writeLine(deps.stderr, `pi-sandbox: warning: could not end the launch: ${errorMessage(error)}`);
  }

  if (!last.stopped) {
    await sweep?.(false);
  }
};

export const othersLive = async (stateDir: string, repoHash: string, launchId?: string) =>
  (await liveLaunches(stateDir, repoHash)).some((entry) => entry.launchId !== launchId);

export const busyLaunches = async (stateDir: string) => (await liveLaunches(stateDir)).length;
