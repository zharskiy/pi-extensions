import { type Backend, selectBackend } from "../backend/index.ts";
import { findRepoContainer, removeRepoContainer } from "../container/index.ts";
import { withRepoSessionLock } from "../grants/index.ts";
import { prepareHostSessions, probeHostSessions, sweepHostSessions } from "../provision/index.ts";
import { errorMessage, LauncherError } from "../shared/index.ts";
import {
  assertHostSessionsDir,
  type HostSessions,
  hostSessionsChoice,
  hostSessionsDir,
  sessionsSwitchNotice,
} from "../workspace/index.ts";
import { type CliDeps, hostAgentDirOf, writeLine, writeNotices } from "./deps.ts";
import type { LaunchContext } from "./launch.ts";
import { othersLive } from "./sessions.ts";

export const hostSessionsOf = (
  deps: CliDeps,
  context: LaunchContext,
  settings: Record<string, unknown> | undefined,
): HostSessions =>
  hostSessionsChoice({
    enabled: context.effective.config.sessions.host,
    home: deps.home,
    env: deps.env,
    settings,
    repoRoot: context.workspace.repoRoot,
  });

export const noticeHostSessions = (deps: CliDeps, sessions: HostSessions) => {
  const off =
    "off" in sessions && sessions.notice
      ? [`sessions: ${sessions.off}, so sandbox sessions stay in the sandbox volume`]
      : [];
  const ignored = sessionsSwitchNotice(deps.env);

  writeNotices(deps, [...off, ...(ignored === undefined ? [] : [ignored])]);
};

const sweptDir = (deps: CliDeps, context: LaunchContext) =>
  hostSessionsDir(hostAgentDirOf(deps), context.workspace.repoRoot);

const containerRunning = async (backend: Backend, context: LaunchContext) =>
  (await findRepoContainer(backend, context.workspace))?.state === "running";

const warnUnswept = (deps: CliDeps, dir: string, error: unknown) => {
  writeLine(deps.stderr, `pi-sandbox: warning: sessions: ${dir} was not swept: ${errorMessage(error)}`);
};

const sweep = async (deps: CliDeps, context: LaunchContext, full: boolean): Promise<string[]> => {
  const dir = sweptDir(deps, context);

  try {
    const { notices, failures } = await sweepHostSessions({
      dir,
      repoRoot: context.workspace.repoRoot,
      full,
    });

    writeNotices(deps, notices);

    return failures;
  } catch (error) {
    warnUnswept(deps, dir, error);

    return [];
  }
};

const refuseStuck = (deps: CliDeps, context: LaunchContext, failures: string[]) => {
  if (failures.length === 0) {
    return;
  }

  const dir = sweptDir(deps, context);

  throw new LauncherError(
    `sessions: ${failures.join("; ")}, in ${dir}; refusing to run pi while host pi could read it`,
    `fix the permissions in ${dir} or remove the file by hand`,
  );
};

const sweepWhenIdle = async (
  deps: CliDeps,
  context: LaunchContext,
  running: () => Promise<boolean>,
  launchId?: string,
) => {
  try {
    return await withRepoSessionLock(context.stateDir, context.repoHash, async () => {
      const others = await othersLive(context.stateDir, context.repoHash, launchId);

      return sweep(deps, context, !others && !(await running()));
    });
  } catch (error) {
    warnUnswept(deps, sweptDir(deps, context), error);

    return [];
  }
};

export const readyHostSessions = async (
  deps: CliDeps,
  context: LaunchContext,
  backend: Backend,
  parts: { sessions: HostSessions; launchId: string },
) => {
  const { sessions } = parts;

  if ("dir" in sessions) {
    await prepareHostSessions(sessions.dir);

    assertHostSessionsDir(sessions.dir, {
      home: deps.home,
      agentDir: hostAgentDirOf(deps),
      repoRoot: context.workspace.repoRoot,
    });
  }

  refuseStuck(
    deps,
    context,
    await sweepWhenIdle(deps, context, () => containerRunning(backend, context), parts.launchId),
  );
};

const notShared = (dir: string) =>
  new LauncherError(
    `sessions: ${dir} is not writable from the sandbox; set sessions.host: false or share it with the VM`,
  );

export const probeSessionsShare = async (
  backend: Backend,
  context: LaunchContext,
  containerId: string,
  sessions: HostSessions,
) => {
  if ("off" in sessions) {
    return;
  }

  const discard = () => removeRepoContainer(backend, context.workspace.repoRoot);
  const shared = await probeHostSessions(backend, containerId, sessions.dir).catch(async (error: unknown) => {
    await discard();

    throw error;
  });

  if (shared) {
    return;
  }

  await discard();

  throw notShared(sessions.dir);
};

export const sessionsSweeper = (deps: CliDeps, context: LaunchContext) => async (full: boolean) => {
  const failures = await sweep(deps, context, full);

  writeNotices(
    deps,
    failures.map((failure) => `warning: sessions: ${failure}; the next launch refuses until it is fixed`),
  );
};

const runningOrUnknown = (deps: CliDeps, context: LaunchContext) => () =>
  selectBackend(context.effective.config.backend, deps.adapters())
    .then((backend) => containerRunning(backend, context))
    .catch(() => true);

export const sweepForHostPi = async (deps: CliDeps, context: LaunchContext) => {
  refuseStuck(deps, context, await sweepWhenIdle(deps, context, runningOrUnknown(deps, context)));
};
