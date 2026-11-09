import type { Backend } from "../backend/index.ts";
import { type GitGuardContext, gitLaunchEndNotices } from "../container/index.ts";
import { endLaunch, type Launch, liveLaunches, newLaunchId, registerLaunch } from "../grants/index.ts";
import { errorMessage, processMark, writeRepoRecord } from "../shared/index.ts";
import { type CliDeps, writeLine, writeNotices } from "./deps.ts";
import { sweepRepoSessions } from "./host-sessions.ts";
import type { LaunchContext } from "./launch.ts";
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
  home: deps.home,
  env: deps.env,
  stateDir: context.stateDir,
});

const settleGit = async (deps: CliDeps, context: LaunchContext) => {
  const notices = await gitLaunchEndNotices(context.workspace, gitGuardOf(deps, context)).catch(
    (error: unknown) => [`warning: git: the check after the session failed: ${errorMessage(error)}`],
  );

  writeNotices(deps, notices);
};

export const finishLaunch = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  launch: Launch,
) => {
  const last = { done: false };

  try {
    await endLaunch(context.stateDir, {
      repoHash: launch.repoHash,
      launchId: launch.launchId,
      onLast: async () => {
        last.done = true;

        await removeRepoSandbox(deps, backend, context.repoHash);
      },
    });
  } catch (error) {
    writeLine(deps.stderr, `pi-sandbox: warning: could not end the launch: ${errorMessage(error)}`);
  }

  if (last.done) {
    await settleGit(deps, context);
  } else {
    await sweepRepoSessions(deps, context.workspace.repoRoot, false);
  }

  await sweepOrphans(deps, backend);
};

export const othersLive = async (stateDir: string, repoHash: string, launchId?: string) =>
  (await liveLaunches(stateDir, repoHash)).some((entry) => entry.launchId !== launchId);

export const busyLaunches = async (stateDir: string) => (await liveLaunches(stateDir)).length;
