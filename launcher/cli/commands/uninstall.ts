import { type Backend, LABELS } from "../../backend/index.ts";
import { discardContainer } from "../../container/index.ts";
import { liveLaunches, withRepoLaunchLock } from "../../grants/index.ts";
import { errorMessage, knownRepos } from "../../shared/index.ts";
import { type CliDeps, pathsOf, writeLine, writeLines } from "../deps.ts";
import { removeRepoSandbox } from "../sweep.ts";

export const UNINSTALL = "__uninstall";

const SESSIONS_LIVE_EXIT = 75;

const isManaged = (labels: Record<string, string>) => labels[LABELS.managed] === "true";

const settled = async <T>(items: T[], remove: (item: T) => Promise<unknown>) =>
  (await Promise.allSettled(items.map(remove))).filter((outcome) => outcome.status === "fulfilled").length;

const removeEngineObjects = async (backend: Backend) => {
  if (!(await backend.detect()).available) {
    return ["engine: the sandbox VM is not running, its objects go with the colima profile"];
  }

  const containers = await backend.findContainers({ [LABELS.managed]: "true" });
  const removedContainers = await settled(containers, (container) => discardContainer(backend, container));
  const networks = (await backend.listNetworks()).filter((network) => isManaged(network.labels));
  const removedNetworks = await settled(networks, (network) =>
    backend.removeRepoNetwork(network.labels[LABELS.repoHash] ?? ""),
  );
  const volumes = await backend.listVolumes();
  const removedVolumes = await settled(volumes, (volume) => backend.removeVolume(volume.name));
  const images = (await backend.listImages()).filter((image) => isManaged(image.labels));
  const removedImages = await settled(images, (image) => backend.removeImage(image.id));

  return [
    `engine: removed ${removedContainers} containers, ${removedNetworks} networks, ${removedVolumes} volumes and ${removedImages} images`,
  ];
};

const releaseRepos = async (deps: CliDeps, stateDir: string) => {
  const repos = await knownRepos(stateDir);
  const lines = await Promise.all(
    repos.map((repoHash) =>
      withRepoLaunchLock(stateDir, repoHash, () => removeRepoSandbox(deps, undefined, repoHash)).catch(
        (error: unknown) => [
          `host: the sandbox of ${repoHash.slice(0, 12)} was not released: ${errorMessage(error)}`,
        ],
      ),
    ),
  );

  return [...lines.flat(), `host: released the created folders and proxies of ${repos.length} folders`];
};

export const uninstallCommand = async (deps: CliDeps) => {
  const { stateDir } = pathsOf(deps);
  const live = (await liveLaunches(stateDir)).length;

  if (live > 0) {
    writeLine(deps.stderr, `pi-sandbox: ${live} pi sessions still run in the sandbox; exit them first`);

    return SESSIONS_LIVE_EXIT;
  }

  const engine = await removeEngineObjects(deps.backend()).catch((error: unknown) => [
    `engine: not cleaned (${errorMessage(error)}), its objects go with the colima profile`,
  ]);

  writeLines(deps.stdout, [...engine, ...(await releaseRepos(deps, stateDir))]);

  return 0;
};
