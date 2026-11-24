import { type Backend, busyText, LABELS, type VmBusy } from "../../backend/index.ts";
import { othersLive, withLaunchLock } from "../../grants/index.ts";
import { errorMessage, knownRepos, LauncherError } from "../../shared/index.ts";
import { vmSessions } from "../busy.ts";
import { type CliDeps, pathsOf, writeLine, writeLines } from "../deps.ts";
import { removeGround, withGroundLock } from "../ground.ts";
import { whenNotPreparing } from "../prepare.ts";
import { removeRepoSandbox } from "../sweep.ts";

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
  const outcome = await whenNotPreparing(stateDir, repoHash, async () =>
    (await othersLive(stateDir, repoHash))
      ? startedMeanwhile(repoHash)
      : removeRepoSandbox(deps, repoHash, backend),
  );

  return outcome.busy ? startedMeanwhile(repoHash) : outcome.value;
};

const releaseRepos = async (deps: CliDeps, stateDir: string, backend: Backend | undefined) => {
  const known = await knownRepos(stateDir);
  const inEngine = backend === undefined ? [] : await engineRepos(backend).catch(() => []);
  const repos = [...new Set([...known, ...inEngine])];
  const lines = await Promise.all(repos.map((repoHash) => releaseRepo(deps, stateDir, backend, repoHash)));

  return [
    ...lines.flat(),
    `host: released the created folders of ${known.length} ${known.length === 1 ? "folder" : "folders"}`,
  ];
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

      const ground = await removeGround(deps, stateDir, backend);
      const stored = await releaseStored(backend);

      return [...ground.map((line) => `install: ${line}`), ...stored];
    }),
  );

export const releaseSandbox = async (deps: CliDeps) => {
  const { stateDir } = pathsOf(deps);
  const sessions = await vmSessions(deps.backend(), stateDir);

  if (sessions.count > 0) {
    throw new LauncherError(`${busyText(sessions)} in the sandbox VM`, "exit them, then run this again");
  }

  const backend = await reachableEngine(deps.backend());
  const released = await releaseRepos(deps, stateDir, backend);
  const install = await releaseInstall(deps, stateDir, backend);

  writeLines(deps.stdout, released);

  if (!Array.isArray(install)) {
    throw new LauncherError(
      `a pi session started in the sandbox VM meanwhile (${busyText(install)}), so the sandbox network, proxy, services, volumes and images were kept`,
      "exit it, then uninstall again",
    );
  }

  writeLines(deps.stdout, install);
};
