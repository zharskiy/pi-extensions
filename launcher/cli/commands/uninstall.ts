import { type Backend, busyText, LABELS, type VmBusy } from "../../backend/index.ts";
import { othersLive, withLaunchLock } from "../../grants/index.ts";
import { errorMessage, knownRepos } from "../../shared/index.ts";
import { vmSessions } from "../busy.ts";
import { type CliDeps, pathsOf, writeLine, writeLines } from "../deps.ts";
import { removeGround, withGroundLock } from "../ground.ts";
import { whenNotPreparing } from "../prepare.ts";
import { removeRepoSandbox } from "../sweep.ts";

export const UNINSTALL = "__uninstall";

const SESSIONS_LIVE_EXIT = 75;

const isManaged = (labels: Record<string, string>) => labels[LABELS.managed] === "true";

const settled = async <T>(items: T[], remove: (item: T) => Promise<unknown>) =>
  (await Promise.allSettled(items.map(remove))).filter((outcome) => outcome.status === "fulfilled").length;

const engineRepos = async (backend: Backend) => {
  const containers = await backend.findContainers({});

  return containers.flatMap((item) => {
    const hash = item.labels[LABELS.repoHash];

    return hash === undefined ? [] : [hash];
  });
};

const startedMeanwhile = (repoHash: string) => [
  `host: a pi session of ${repoHash.slice(0, 12)} started meanwhile; its sandbox stays`,
];

const releaseRepo = async (
  deps: CliDeps,
  stateDir: string,
  backend: Backend | undefined,
  repoHash: string,
) => {
  try {
    const outcome = await whenNotPreparing(stateDir, repoHash, async () =>
      (await othersLive(stateDir, repoHash))
        ? startedMeanwhile(repoHash)
        : removeRepoSandbox(deps, repoHash, backend),
    );

    return outcome.busy ? startedMeanwhile(repoHash) : outcome.value;
  } catch (error) {
    return [`host: the sandbox of ${repoHash.slice(0, 12)} was not released: ${errorMessage(error)}`];
  }
};

const releaseRepos = async (deps: CliDeps, stateDir: string, backend: Backend | undefined) => {
  const known = await knownRepos(stateDir);
  const inEngine = backend === undefined ? [] : await engineRepos(backend).catch(() => []);
  const repos = [...new Set([...known, ...inEngine])];
  const lines = await Promise.all(repos.map((repoHash) => releaseRepo(deps, stateDir, backend, repoHash)));

  return [...lines.flat(), `host: released the created folders of ${known.length} folders`];
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

const releaseGround = async (deps: CliDeps, stateDir: string, backend: Backend | undefined) => {
  try {
    return await removeGround(deps, stateDir, backend);
  } catch (error) {
    return [`the sandbox network, proxy and services were not all released: ${errorMessage(error)}`];
  }
};

const releaseStored = (backend: Backend | undefined) =>
  backend === undefined
    ? Promise.resolve(["engine: the sandbox VM is not running, its objects go with the colima profile"])
    : removeStored(backend).catch((error: unknown) => [
        `engine: not cleaned (${errorMessage(error)}), its objects go with the colima profile`,
      ]);

const releaseInstall = (deps: CliDeps, stateDir: string, backend: Backend | undefined) =>
  withGroundLock({ stateDir, progress: (line) => writeLine(deps.stderr, line) }, () =>
    withLaunchLock(stateDir, async (): Promise<VmBusy | string[]> => {
      const sessions = await vmSessions(deps.backend(), stateDir);

      if (sessions.count > 0) {
        return sessions;
      }

      const ground = await releaseGround(deps, stateDir, backend);
      const stored = await releaseStored(backend);

      return [...ground.map((line) => `install: ${line}`), ...stored];
    }),
  );

const kept = (sessions: VmBusy) =>
  `pi-sandbox: a pi session started in the sandbox VM meanwhile (${busyText(sessions)}), so the sandbox network, proxy, services, volumes and images were kept; exit it, then uninstall again`;

export const uninstallCommand = async (deps: CliDeps) => {
  const { stateDir } = pathsOf(deps);
  const sessions = await vmSessions(deps.backend(), stateDir);

  if (sessions.count > 0) {
    writeLine(deps.stderr, `pi-sandbox: ${busyText(sessions)} in the sandbox VM; exit them first`);

    return SESSIONS_LIVE_EXIT;
  }

  const backend = await reachableEngine(deps.backend());
  const released = await releaseRepos(deps, stateDir, backend);
  const install = await releaseInstall(deps, stateDir, backend);

  if (!Array.isArray(install)) {
    writeLines(deps.stdout, released);

    writeLine(deps.stderr, kept(install));

    return SESSIONS_LIVE_EXIT;
  }

  writeLines(deps.stdout, [...install, ...released]);

  return 0;
};
