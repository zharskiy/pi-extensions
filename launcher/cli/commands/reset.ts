import { rm } from "node:fs/promises";
import { type Backend, ENGINE_PROFILE, LABELS } from "../../backend/index.ts";
import { liveLaunches, withRepoLaunchLock } from "../../grants/index.ts";
import { LauncherError, stateLayout } from "../../shared/index.ts";
import { type LaunchContext, openContext } from "../context.ts";
import { type CliDeps, writeLines } from "../deps.ts";
import { removeRepoSandbox } from "../sweep.ts";

const ownVolumes = async (context: LaunchContext, backend: Backend) =>
  (await backend.listVolumes()).filter((volume) => volume.labels[LABELS.repoHash] === context.repoHash);

const refuseLive = async (stateDir: string, context: LaunchContext) => {
  const count = (await liveLaunches(stateDir, context.repoHash)).length;

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
  const removed = await removeRepoSandbox(deps, backend, repoHash);

  await rm(stateLayout(stateDir).repo(repoHash).render, { recursive: true, force: true });

  if (!reachable) {
    writeLines(deps.stdout, [...removed, ENGINE_SKIPPED]);

    return;
  }

  const lines = [...removed, ...(await removeVolumes(context, backend))];

  writeLines(deps.stdout, lines.length === 0 ? [`no sandbox for ${workspace.repoRoot}`] : lines);
};

export const resetCommand = async (deps: CliDeps) => {
  const { context } = await openContext(deps, "host");

  await withRepoLaunchLock(context.stateDir, context.repoHash, () => reset(deps, context, deps.backend()));

  return 0;
};
