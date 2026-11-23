import { rm } from "node:fs/promises";
import { type Backend, installIdOf, LABELS } from "../../backend/index.ts";
import { agentVolumeName, isLegacyAgentVolume } from "../../container/index.ts";
import { liveLaunches } from "../../grants/index.ts";
import { knownRepos, LauncherError, stateLayout, withFileLock } from "../../shared/index.ts";
import { busyLaunches } from "../busy.ts";
import { type LaunchContext, openContext } from "../context.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { wipeServices } from "../ground.ts";
import { withAgentLock, withPrepareLock } from "../prepare.ts";
import { removeRepoSandbox } from "../sweep.ts";

export const SERVICES_FLAG = "--services";

export const AGENT_FLAG = "--agent";

const RENDER_LOCK_TIMEOUT_MS = 30_000;

const ownVolumes = async (context: LaunchContext, backend: Backend) =>
  (await backend.listVolumes()).filter((volume) => volume.labels[LABELS.repoHash] === context.repoHash);

const refuseLive = async (stateDir: string, context: LaunchContext) => {
  const launches = await liveLaunches(stateDir);
  const count = launches.filter((launch) => launch.repoHash === context.repoHash).length;

  if (count > 0) {
    throw new LauncherError(
      `${count} ${count === 1 ? "session is" : "sessions are"} running in ${context.workspace.repoRoot}`,
      "exit them, then run pi sandbox reset again",
    );
  }
};

const ENGINE_SKIPPED = `the sandbox VM is not running, so the engine step was skipped; run pi (it starts the sandbox VM with its planned shares) and exit it, then pi sandbox reset again to remove the container and volumes`;

const keptVolumeLine = (name: string, flag: string) =>
  `kept volume ${name}: a container still mounts it, run pi sandbox reset${flag} again`;

const removeVolumes = async (context: LaunchContext, backend: Backend) => {
  const volumes = await ownVolumes(context, backend);
  const free = volumes.filter((volume) => !volume.inUse);

  await Promise.all(free.map((volume) => backend.removeVolume(volume.name)));

  await rm(stateLayout(context.stateDir).repo(context.repoHash).legacy.sync, {
    recursive: true,
    force: true,
  });

  return [
    ...free.map((volume) => `removed volume ${volume.name}`),
    ...volumes.filter((volume) => volume.inUse).map((volume) => keptVolumeLine(volume.name, "")),
  ];
};

const sharedKeptLine = async (context: LaunchContext, backend: Backend) => {
  const name = agentVolumeName(installIdOf(context.stateDir));
  const volumes = await backend.listVolumes();

  return volumes.some((volume) => volume.name === name)
    ? [
        `kept volume ${name}: the pi folder every folder's sandbox shares; pi sandbox reset ${AGENT_FLAG} removes it`,
      ]
    : [];
};

const reset = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  const { workspace, stateDir, repoHash } = context;

  await refuseLive(stateDir, context);

  const reachable = (await backend.detect()).available;
  const removed = await removeRepoSandbox(deps, repoHash, reachable ? backend : undefined);

  await rm(stateLayout(stateDir).repo(repoHash).legacy.render, { recursive: true, force: true });

  if (!reachable) {
    writeLines(deps.stdout, [...removed, ENGINE_SKIPPED]);

    return;
  }

  const lines = [...removed, ...(await removeVolumes(context, backend))];

  writeLines(deps.stdout, [
    ...(lines.length === 0 ? [`no sandbox for ${workspace.repoRoot}`] : lines),
    ...(await sharedKeptLine(context, backend)),
  ]);
};

const SERVICES_SKIPPED = `the sandbox VM is not running, so its services hold no data to remove now; run pi (it starts the sandbox VM with its planned shares) and exit it, then pi sandbox reset ${SERVICES_FLAG} again`;

const resetServices = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  if (!(await backend.detect()).available) {
    writeLines(deps.stdout, [SERVICES_SKIPPED]);

    return;
  }

  const lines = await wipeServices(backend, context.stateDir, {
    services: context.effective.config.services,
    progress: (line) => writeLine(deps.stderr, line),
  });

  writeLines(deps.stdout, lines.length === 0 ? ["no services to remove"] : lines);
};

const AGENT_SKIPPED = `the sandbox VM is not running, so nothing was removed; run pi (it starts the sandbox VM with its planned shares) and exit it, then pi sandbox reset ${AGENT_FLAG} again`;

const AGENT_BUSY = "a pi session is running, so the shared pi folder was kept";

const AGENT_BUSY_HINT = `end every pi session, then run pi sandbox reset ${AGENT_FLAG} again`;

const SESSIONS_REMOVED =
  "the pi sessions kept in the sandbox while sessions.host is off were removed with the volume";

const agentVolumes = async (stateDir: string, backend: Backend) => {
  const install = installIdOf(stateDir);
  const shared = agentVolumeName(install);
  const volumes = await backend.listVolumes();

  return volumes.filter((volume) => volume.name === shared || isLegacyAgentVolume(install, volume.name));
};

const removeAgentRecords = async (stateDir: string) => {
  const layout = stateLayout(stateDir);
  const legacy = (await knownRepos(stateDir)).map((hash) => layout.repo(hash).legacy.sync);
  const paths = [layout.render, layout.renders, layout.sync.directory, ...legacy];

  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
};

const wipeAgent = async (context: LaunchContext, backend: Backend) => {
  const { stateDir } = context;

  if ((await busyLaunches(stateDir)) > 0) {
    throw new LauncherError(AGENT_BUSY, AGENT_BUSY_HINT);
  }

  const volumes = await agentVolumes(stateDir, backend);
  const free = volumes.filter((volume) => !volume.inUse);
  const kept = volumes.filter((volume) => volume.inUse);

  await Promise.all(free.map((volume) => backend.removeVolume(volume.name)));

  if (kept.length === 0) {
    await removeAgentRecords(stateDir);
  }

  const sessionsLost = free.length > 0 && !context.effective.config.sessions.host;

  return [
    ...free.map((volume) => `removed volume ${volume.name}`),
    ...kept.map((volume) => keptVolumeLine(volume.name, ` ${AGENT_FLAG}`)),
    ...(sessionsLost ? [SESSIONS_REMOVED] : []),
  ];
};

const resetAgent = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  if (!(await backend.detect()).available) {
    writeLines(deps.stdout, [AGENT_SKIPPED]);

    return;
  }

  const lock = { stateDir: context.stateDir, progress: (line: string) => writeLine(deps.stderr, line) };
  const lines = await withAgentLock(lock, () =>
    withFileLock(stateLayout(context.stateDir).renderLock, () => wipeAgent(context, backend), {
      timeoutMs: RENDER_LOCK_TIMEOUT_MS,
    }),
  );

  writeLines(deps.stdout, lines.length === 0 ? ["no shared pi folder to remove"] : lines);
};

export const resetCommand = async (deps: CliDeps, args: string[] = []) => {
  if (args.includes(SERVICES_FLAG) && args.includes(AGENT_FLAG)) {
    throw new LauncherError(
      `${SERVICES_FLAG} and ${AGENT_FLAG} do not go together`,
      "run them one at a time",
    );
  }

  const { context } = await openContext(deps, "host");

  if (args.includes(SERVICES_FLAG)) {
    await resetServices(deps, context, deps.backend());

    return 0;
  }

  if (args.includes(AGENT_FLAG)) {
    await resetAgent(deps, context, deps.backend());

    return 0;
  }

  const lock = {
    stateDir: context.stateDir,
    repoHash: context.repoHash,
    progress: (line: string) => writeLine(deps.stderr, line),
  };

  await withPrepareLock(lock, () => reset(deps, context, deps.backend()));

  return 0;
};
