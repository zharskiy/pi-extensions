import { type Backend, LABELS } from "../../backend/index.ts";
import { liveLaunches, withRepoLaunchLock } from "../../grants/index.ts";
import { errorMessage, knownRepos } from "../../shared/index.ts";
import { type CliDeps, pathsOf, writeLine, writeLines } from "../deps.ts";
import { removeRepoSandbox } from "../sweep.ts";

export const UNINSTALL = "__uninstall";

const SESSIONS_LIVE_EXIT = 75;

const isManaged = (labels: Record<string, string>) => labels[LABELS.managed] === "true";

const settled = async <T>(items: T[], remove: (item: T) => Promise<unknown>) =>
  (await Promise.allSettled(items.map(remove))).filter((outcome) => outcome.status === "fulfilled").length;

const engineRepos = async (backend: Backend) => {
  const [containers, networks] = await Promise.all([
    backend.findContainers({ [LABELS.managed]: "true" }),
    backend.listNetworks(),
  ]);

  return [...containers, ...networks].flatMap((item) => {
    const hash = item.labels[LABELS.repoHash];

    return hash === undefined ? [] : [hash];
  });
};

const releaseRepo = (deps: CliDeps, stateDir: string, backend: Backend | undefined, repoHash: string) =>
  withRepoLaunchLock(stateDir, repoHash, async () =>
    (await liveLaunches(stateDir, repoHash)).length > 0
      ? [`host: a pi session of ${repoHash.slice(0, 12)} started meanwhile; its sandbox stays`]
      : removeRepoSandbox(deps, backend, repoHash),
  ).catch((error: unknown) => [
    `host: the sandbox of ${repoHash.slice(0, 12)} was not released: ${errorMessage(error)}`,
  ]);

const releaseRepos = async (deps: CliDeps, stateDir: string, backend: Backend | undefined) => {
  const known = await knownRepos(stateDir);
  const inEngine = backend === undefined ? [] : await engineRepos(backend).catch(() => []);
  const repos = [...new Set([...known, ...inEngine])];
  const lines = await Promise.all(repos.map((repoHash) => releaseRepo(deps, stateDir, backend, repoHash)));

  return [...lines.flat(), `host: released the created folders and proxies of ${known.length} folders`];
};

const removeStored = async (backend: Backend) => {
  const volumes = await backend.listVolumes();
  const removedVolumes = await settled(volumes, (volume) => backend.removeVolume(volume.name));
  const images = (await backend.listImages()).filter((image) => isManaged(image.labels));
  const removedImages = await settled(images, (image) => backend.removeImage(image.id));

  return [`engine: removed ${removedVolumes} volumes and ${removedImages} images`];
};

const reachableEngine = async (backend: Backend) =>
  (await backend.detect()).available ? backend : undefined;

export const uninstallCommand = async (deps: CliDeps) => {
  const { stateDir } = pathsOf(deps);
  const live = (await liveLaunches(stateDir)).length;

  if (live > 0) {
    writeLine(deps.stderr, `pi-sandbox: ${live} pi sessions still run in the sandbox; exit them first`);

    return SESSIONS_LIVE_EXIT;
  }

  const backend = await reachableEngine(deps.backend());
  const released = await releaseRepos(deps, stateDir, backend);
  const stored =
    backend === undefined
      ? ["engine: the sandbox VM is not running, its objects go with the colima profile"]
      : await removeStored(backend).catch((error: unknown) => [
          `engine: not cleaned (${errorMessage(error)}), its objects go with the colima profile`,
        ]);

  writeLines(deps.stdout, [...stored, ...released]);

  return 0;
};
