import { rm } from "node:fs/promises";
import type { Backend } from "../../backend/index.ts";
import { LABELS, policyHashesInUse, removeRepoContainer, repoVolumes } from "../../container/index.ts";
import { proxyPolicyHash } from "../../proxy/index.ts";
import { LauncherError, stateLayout } from "../../shared/index.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { type LaunchContext, openContext } from "../launch.ts";

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
  const { workspace, effective, stateDir, repoHash } = context;
  const removed = await removeRepoContainer(backend, workspace.repoRoot);

  writeLines(
    deps.stdout,
    removed.map((container) => `removed container ${container.name} (${container.id})`),
  );

  if (removed.length === 0) {
    writeLine(deps.stdout, `no container for ${workspace.repoRoot}`);
  }

  const layout = stateLayout(stateDir).repo(repoHash);

  await rm(layout.render, { recursive: true, force: true });

  const policyHash = proxyPolicyHash(effective.config);

  if ((await policyHashesInUse(backend)).includes(policyHash)) {
    writeLine(deps.stdout, `kept proxy instance ${policyHash}, in use by another repository`);
  } else if (await deps.proxy.remove(stateDir, policyHash)) {
    writeLine(deps.stdout, `removed proxy instance ${policyHash}`);
  }

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
