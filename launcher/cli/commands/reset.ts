import { rm } from "node:fs/promises";
import type { Backend } from "../../backend/index.ts";
import { LABELS, repoVolumes } from "../../container/index.ts";
import { withRepoLaunchLock } from "../../grants/index.ts";
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

export const resetCommand = async (deps: CliDeps, args: string[]) => {
  const unknown = args.find((arg) => arg !== VOLUMES);

  if (unknown !== undefined) {
    throw new LauncherError(`unknown reset option "${unknown}"`, "pi sandbox reset [--volumes]");
  }

  const { context, backend } = await openContext(deps, "admin");
  const { workspace, stateDir, repoHash } = context;
  const removed = await withRepoLaunchLock(stateDir, repoHash, () =>
    removeRepoSandbox(deps, backend, repoHash),
  );

  writeLines(deps.stdout, removed);

  if (removed.length === 0) {
    writeLine(deps.stdout, `no sandbox for ${workspace.repoRoot}`);
  }

  const layout = stateLayout(stateDir).repo(repoHash);

  await rm(layout.render, { recursive: true, force: true });

  if (!args.includes(VOLUMES)) {
    return 0;
  }

  const volumes = await ownVolumes(deps, context, backend);

  await Promise.all(volumes.map((name) => backend.removeVolume(name)));

  await rm(layout.sync, { recursive: true, force: true });

  writeLines(
    deps.stdout,
    volumes.map((name) => `removed volume ${name}`),
  );

  return 0;
};
