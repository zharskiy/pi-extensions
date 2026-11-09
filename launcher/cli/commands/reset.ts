import { rm } from "node:fs/promises";
import type { Backend } from "../../backend/index.ts";
import { LABELS, repoVolumes } from "../../container/index.ts";
import { liveLaunches, withRepoLaunchLock } from "../../grants/index.ts";
import { LauncherError, stateLayout } from "../../shared/index.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { type LaunchContext, openContext } from "../launch.ts";
import { removeRepoSandbox } from "../sweep.ts";

const VOLUMES = "--volumes";

const CACHE_PREFIX = "pi-sandbox-cache-";

const ownVolumes = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  const named = repoVolumes({
    workspace: context.workspace,
    config: context.effective.config,
    hostEnv: deps.env,
    uid: deps.uid,
  });
  const labelled = (await backend.listVolumes())
    .filter(
      (volume) => volume.labels[LABELS.repoHash] === context.repoHash && volume.name.startsWith(CACHE_PREFIX),
    )
    .map((volume) => volume.name);

  return [...new Set([...named, ...labelled])];
};

const refuseLive = async (stateDir: string, context: LaunchContext) => {
  const count = (await liveLaunches(stateDir, context.repoHash)).length;

  if (count > 0) {
    throw new LauncherError(
      `${count} ${count === 1 ? "session is" : "sessions are"} running in ${context.workspace.repoRoot}`,
      "exit them, then run pi sandbox reset again",
    );
  }
};

const ENGINE_SKIPPED =
  "the sandbox VM is not running, so the engine step was skipped; run pi sandbox reset again after the next pi starts it to remove the container and volumes";

const reset = async (deps: CliDeps, context: LaunchContext, backend: Backend, withVolumes: boolean) => {
  const { workspace, stateDir, repoHash } = context;

  await refuseLive(stateDir, context);

  const reachable = (await backend.detect()).available;
  const removed = await removeRepoSandbox(deps, backend, repoHash);

  writeLines(deps.stdout, removed);

  if (removed.length === 0 && reachable) {
    writeLine(deps.stdout, `no sandbox for ${workspace.repoRoot}`);
  }

  const layout = stateLayout(stateDir).repo(repoHash);

  await rm(layout.render, { recursive: true, force: true });

  if (!reachable) {
    writeLine(deps.stdout, ENGINE_SKIPPED);

    return;
  }

  if (!withVolumes) {
    return;
  }

  const volumes = await ownVolumes(deps, context, backend);

  await Promise.all(volumes.map((name) => backend.removeVolume(name)));

  await rm(layout.sync, { recursive: true, force: true });

  writeLines(
    deps.stdout,
    volumes.map((name) => `removed volume ${name}`),
  );
};

export const resetCommand = async (deps: CliDeps, args: string[]) => {
  const unknown = args.find((arg) => arg !== VOLUMES);

  if (unknown !== undefined) {
    throw new LauncherError(`unknown reset option "${unknown}"`, "pi sandbox reset [--volumes]");
  }

  const { context } = await openContext(deps, "host");

  await withRepoLaunchLock(context.stateDir, context.repoHash, () =>
    reset(deps, context, deps.backend(), args.includes(VOLUMES)),
  );

  return 0;
};
