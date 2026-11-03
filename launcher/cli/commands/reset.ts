import { policyHashesInUse, removeRepoContainer, repoVolumes } from "../../container/index.ts";
import { proxyPolicyHash } from "../../proxy/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { openBackend, openContext } from "../launch.ts";

const VOLUMES = "--volumes";

export const resetCommand = async (deps: CliDeps, args: string[]) => {
  const unknown = args.find((arg) => arg !== VOLUMES);

  if (unknown !== undefined) {
    throw new LauncherError(`unknown reset option "${unknown}"`, "pi sandbox reset [--volumes]");
  }

  const { workspace, effective, stateDir } = await openContext(deps);
  const backend = await openBackend(deps, effective.config);
  const removed = await removeRepoContainer(backend, workspace.repoRoot);

  writeLines(
    deps.stdout,
    removed.map((container) => `removed container ${container.name} (${container.id})`),
  );

  if (removed.length === 0) {
    writeLine(deps.stdout, `no container for ${workspace.repoRoot}`);
  }

  const policyHash = proxyPolicyHash(effective.config);

  if ((await policyHashesInUse(backend)).includes(policyHash)) {
    writeLine(deps.stdout, `kept proxy instance ${policyHash}, in use by another repository`);
  } else if (await deps.proxy.remove(stateDir, policyHash)) {
    writeLine(deps.stdout, `removed proxy instance ${policyHash}`);
  }

  if (!args.includes(VOLUMES)) {
    return 0;
  }

  const volumes = repoVolumes({ workspace, config: effective.config, hostEnv: deps.env, uid: deps.uid });

  await Promise.all(volumes.map((name) => backend.removeVolume(name)));

  writeLines(
    deps.stdout,
    volumes.map((name) => `removed volume ${name}`),
  );

  return 0;
};
