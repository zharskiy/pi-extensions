import { rm } from "node:fs/promises";
import { type Backend, ENGINE_PROFILE, LABELS } from "../../backend/index.ts";
import { liveLaunches } from "../../grants/index.ts";
import { LauncherError, stateLayout } from "../../shared/index.ts";
import { type LaunchContext, openContext } from "../context.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { wipeServices } from "../ground.ts";
import { withPrepareLock } from "../prepare.ts";
import { removeRepoSandbox } from "../sweep.ts";

export const SERVICES_FLAG = "--services";

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

const ENGINE_SKIPPED = `the sandbox VM is not running, so the engine step was skipped; run colima start --profile ${ENGINE_PROFILE} --activate=false, then pi sandbox reset again to remove the container and volumes`;

const removeVolumes = async (context: LaunchContext, backend: Backend) => {
  const volumes = await ownVolumes(context, backend);
  const free = volumes.filter((volume) => !volume.inUse);

  await Promise.all(free.map((volume) => backend.removeVolume(volume.name)));

  await rm(stateLayout(context.stateDir).repo(context.repoHash).sync, { recursive: true, force: true });

  return [
    ...free.map((volume) => `removed volume ${volume.name}`),
    ...volumes
      .filter((volume) => volume.inUse)
      .map((volume) => `kept volume ${volume.name}: a container still mounts it, run pi sandbox reset again`),
  ];
};

const reset = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  const { workspace, stateDir, repoHash } = context;

  await refuseLive(stateDir, context);

  const reachable = (await backend.detect()).available;
  const removed = await removeRepoSandbox(deps, repoHash, reachable ? backend : undefined);

  await rm(stateLayout(stateDir).repo(repoHash).render, { recursive: true, force: true });

  if (!reachable) {
    writeLines(deps.stdout, [...removed, ENGINE_SKIPPED]);

    return;
  }

  const lines = [...removed, ...(await removeVolumes(context, backend))];

  writeLines(deps.stdout, lines.length === 0 ? [`no sandbox for ${workspace.repoRoot}`] : lines);
};

const SERVICES_SKIPPED = `the sandbox VM is not running, so its services hold no data to remove now; run colima start --profile ${ENGINE_PROFILE} --activate=false, then pi sandbox reset ${SERVICES_FLAG} again`;

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

export const resetCommand = async (deps: CliDeps, args: string[] = []) => {
  const { context } = await openContext(deps, "host");

  if (args.includes(SERVICES_FLAG)) {
    await resetServices(deps, context, deps.backend());

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
