import { type Backend, LABELS, type VmBusy } from "../backend/index.ts";
import { othersLive, withLaunchLock } from "../grants/index.ts";
import { knownRepos } from "../shared/index.ts";
import { vmSessions } from "./busy.ts";
import { type CliDeps, writeLine } from "./deps.ts";
import { withGroundLock } from "./ground.ts";
import { whenNotPreparing } from "./prepare.ts";
import { removeRepoSandbox } from "./sweep.ts";

export interface RepoRelease {
  repoHash: string;
  busy: boolean;
  removed: string[];
}

const isManaged = (labels: Record<string, string>) => labels[LABELS.managed] === "true";

const engineRepos = async (backend: Backend) => {
  const containers = await backend.findContainers({});

  return containers.flatMap((item) => {
    const hash = item.labels[LABELS.repoHash];

    return hash === undefined ? [] : [hash];
  });
};

const releaseRepo = async (
  deps: CliDeps,
  stateDir: string,
  backend: Backend | undefined,
  repoHash: string,
): Promise<RepoRelease> => {
  const outcome = await whenNotPreparing(stateDir, repoHash, async () =>
    (await othersLive(stateDir, repoHash)) ? undefined : removeRepoSandbox(deps, repoHash, backend),
  );
  const removed = outcome.busy ? undefined : outcome.value;

  return { repoHash, busy: removed === undefined, removed: removed ?? [] };
};

export const releaseRepos = async (deps: CliDeps, stateDir: string, backend: Backend | undefined) => {
  const known = await knownRepos(stateDir);
  const inEngine = backend === undefined ? [] : await engineRepos(backend).catch(() => []);
  const repos = [...new Set([...known, ...inEngine])];
  const released = await Promise.all(repos.map((repoHash) => releaseRepo(deps, stateDir, backend, repoHash)));

  return { released, known: known.length };
};

const settled = async <T, R>(items: T[], remove: (item: T) => Promise<R>) =>
  (await Promise.allSettled(items.map(remove))).flatMap((outcome) =>
    outcome.status === "fulfilled" ? [outcome.value] : [],
  );

export const removeStored = async (backend: Backend) => {
  const volumes = await backend.listVolumes();
  const removedVolumes = await settled(volumes, async (volume) => {
    await backend.removeVolume(volume.name);

    return volume.name;
  });
  const images = (await backend.listImages()).filter((image) => isManaged(image.labels));
  const removedImages = await settled(images, (image) => backend.removeImage(image.id));

  return { volumes: removedVolumes, images: removedImages };
};

export type InstallRelease<T> = { busy: VmBusy } | { released: T };

export const withInstallReleased = <T>(deps: CliDeps, stateDir: string, release: () => Promise<T>) =>
  withGroundLock({ stateDir, progress: (line) => writeLine(deps.stderr, line) }, () =>
    withLaunchLock(stateDir, async (): Promise<InstallRelease<T>> => {
      const sessions = await vmSessions(deps.backend(), stateDir);

      if (sessions.count > 0) {
        return { busy: sessions };
      }

      return { released: await release() };
    }),
  );
