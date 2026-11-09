import { access } from "node:fs/promises";
import type { Backend, VolumeSummary } from "../backend/index.ts";
import {
  discardContainer,
  gitDirInUseElsewhere,
  LABELS,
  listLauncherContainers,
  removeRepoContainers,
} from "../container/index.ts";
import { liveLaunches, withRepoLaunchLock } from "../grants/index.ts";
import { removeRepoToken } from "../proxy/index.ts";
import {
  errorMessage,
  forgetRepo,
  hasRepoLeftovers,
  knownRepos,
  readCreatedDirs,
  readJsonObject,
  readPins,
  removeGitCopies,
  repoRootOf,
  stateLayout,
  writeCreatedDirs,
  writeJsonFile,
  writePins,
} from "../shared/index.ts";
import { removeCreatedDirs, unpinRecorded } from "../workspace/index.ts";
import { type CliDeps, pathsOf, writeLine, writeNotices } from "./deps.ts";
import { sweepRepoSessions } from "./host-sessions.ts";

interface SweepOptions {
  collect?: { sharedOwner?: string };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const SHORT_HASH = 12;

const RELAYS = { [LABELS.relay]: "true" };

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const warn = (deps: CliDeps, what: string, error: unknown) => {
  writeLine(deps.stderr, `pi-sandbox: warning: ${what}: ${errorMessage(error)}`);
};

const reachable = async (backend: Backend | undefined) =>
  backend !== undefined && (await backend.detect()).available ? backend : undefined;

const removeEngineSide = async (backend: Backend, repoHash: string) => {
  const containers = await removeRepoContainers(backend, repoHash);
  const relays = await backend.findContainers({ ...RELAYS, [LABELS.repoHash]: repoHash });

  await Promise.all(relays.map((relay) => discardContainer(backend, relay)));

  const network = await backend.removeRepoNetwork(repoHash);

  return [
    ...containers.map((container) => `removed container ${container.name} (${container.id})`),
    ...relays.map((relay) => `removed relay ${relay.name}`),
    ...(network ? [`removed network of ${repoHash.slice(0, SHORT_HASH)}`] : []),
  ];
};

const releasePins = async (deps: CliDeps, backend: Backend | undefined, repoHash: string) => {
  const stateDir = pathsOf(deps).stateDir;
  const inUse = (gitCommonDir: string) =>
    backend === undefined
      ? Promise.resolve(false)
      : gitDirInUseElsewhere(backend, repoHash, gitCommonDir).catch(() => false);
  const { kept, notices } = await unpinRecorded(stateDir, await readPins(stateDir, repoHash), inUse);

  await writePins(stateDir, repoHash, kept);

  writeNotices(deps, notices);
};

const removeCreated = async (stateDir: string, repoHash: string) => {
  const kept = await removeCreatedDirs(await readCreatedDirs(stateDir, repoHash));

  await writeCreatedDirs(stateDir, repoHash, kept);
};

export const removeRepoSandbox = async (deps: CliDeps, backend: Backend | undefined, repoHash: string) => {
  const stateDir = pathsOf(deps).stateDir;
  const engine = await reachable(backend);
  const removed = await (engine === undefined
    ? Promise.resolve([])
    : removeEngineSide(engine, repoHash)
  ).catch((error: unknown) => {
    warn(deps, "the sandbox containers were not removed", error);

    return [];
  });
  const stopped = await deps.proxy.stop(stateDir, repoHash);

  await removeRepoToken(stateDir, repoHash);

  await releasePins(deps, engine, repoHash);

  await removeCreated(stateDir, repoHash);

  await removeGitCopies(stateDir, repoHash);

  const root = await repoRootOf(stateDir, repoHash);

  if (root !== undefined) {
    await sweepRepoSessions(deps, root, true);
  }

  return [...removed, ...(stopped ? [`stopped the proxy of ${repoHash.slice(0, SHORT_HASH)}`] : [])];
};

const removeRepoVolumes = async (backend: Backend | undefined, repoHash: string) => {
  if (backend === undefined) {
    return [];
  }

  const volumes = (await backend.listVolumes()).filter(
    (volume) => volume.labels[LABELS.repoHash] === repoHash && !volume.inUse,
  );
  const removed = await Promise.all(volumes.map((volume) => removedVolume(backend, volume)));

  return removed.flat().map((volume) => `removed volume ${volume.name}`);
};

const sweepRepo = async (deps: CliDeps, engine: Backend | undefined, repoHash: string, inEngine: boolean) => {
  const stateDir = pathsOf(deps).stateDir;
  const live = async () => (await liveLaunches(stateDir, repoHash)).length > 0;

  if (await live()) {
    return [];
  }

  const leftovers = inEngine || (await hasRepoLeftovers(stateDir, repoHash));
  const root = await repoRootOf(stateDir, repoHash);
  const gone = root !== undefined && !(await exists(root));

  if (!leftovers && !gone) {
    return [];
  }

  return withRepoLaunchLock(stateDir, repoHash, async () => {
    if (await live()) {
      return [];
    }

    const lines = leftovers ? await removeRepoSandbox(deps, engine, repoHash) : [];

    if (!gone) {
      return lines;
    }

    await forgetRepo(stateDir, repoHash);

    return [
      ...lines,
      ...(await removeRepoVolumes(engine, repoHash)),
      `forgot ${root}, which no longer exists`,
    ];
  });
};

const repoHashOf = (summary: { labels: Record<string, string> }) => {
  const hash = summary.labels[LABELS.repoHash];

  return hash === undefined ? [] : [hash];
};

const engineRepos = async (engine: Backend | undefined) => {
  if (engine === undefined) {
    return [];
  }

  const [agents, relays, networks] = await Promise.all([
    listLauncherContainers(engine),
    engine.findContainers(RELAYS),
    engine.listNetworks(),
  ]);

  return [...agents, ...relays, ...networks].flatMap(repoHashOf);
};

const removedVolume = (backend: Backend, volume: VolumeSummary) =>
  backend.removeVolume(volume.name).then(
    () => [volume],
    () => [],
  );

const orphaned = async (volume: VolumeSummary) => {
  const root = volume.labels[LABELS.repoRoot];

  return root !== undefined && !volume.inUse && !(await exists(root));
};

const sharedBy = (volume: VolumeSummary, userHash: string | undefined) =>
  userHash !== undefined && volume.labels[LABELS.userHash] === userHash;

const sharedLabel = (volume: VolumeSummary) => volume.labels[LABELS.sharedPath] ?? "unknown path";

const pruneVolumes = async (backend: Backend, sharedOwner: string | undefined) => {
  const volumes = await backend.listVolumes();
  const verdicts = await Promise.all(volumes.map(orphaned));
  const shared = volumes.filter((volume) => sharedBy(volume, sharedOwner));
  const removable = [
    ...volumes.filter((_volume, index) => verdicts[index]),
    ...shared.filter((volume) => !volume.inUse),
  ];
  const removed = (await Promise.all(removable.map((volume) => removedVolume(backend, volume)))).flat();

  return [
    ...removed
      .filter((volume) => !sharedBy(volume, sharedOwner))
      .map((volume) => `removed volume ${volume.name}`),
    ...removed
      .filter((volume) => sharedBy(volume, sharedOwner))
      .map((volume) => `removed shared cache ${volume.name} (${sharedLabel(volume)})`),
    ...shared
      .filter((volume) => volume.inUse)
      .map((volume) => `kept shared cache ${volume.name} (${sharedLabel(volume)}), in use`),
  ];
};

const gcDue = async (deps: CliDeps) => {
  const record = await readJsonObject(stateLayout(pathsOf(deps).stateDir).gcRecord);
  const lastRun = typeof record?.lastRun === "number" ? record.lastRun : 0;

  return deps.now() - lastRun >= DAY_MS;
};

const collectGarbage = async (deps: CliDeps, backend: Backend | undefined, sharedOwner?: string) => {
  const engine = await reachable(backend);
  const lines = engine === undefined ? [] : await pruneVolumes(engine, sharedOwner);

  await writeJsonFile(stateLayout(pathsOf(deps).stateDir).gcRecord, { lastRun: deps.now() });

  return lines;
};

const sweepAll = async (deps: CliDeps, backend: Backend | undefined) => {
  const engine = await reachable(backend);
  const fromEngine = new Set(await engineRepos(engine));
  const hashes = [...new Set([...fromEngine, ...(await knownRepos(pathsOf(deps).stateDir))])];
  const lines = await Promise.all(
    hashes.map((hash) =>
      sweepRepo(deps, engine, hash, fromEngine.has(hash)).catch((error: unknown) => {
        warn(deps, `the sandbox of ${hash.slice(0, SHORT_HASH)} was not swept`, error);

        return [];
      }),
    ),
  );

  return lines.flat();
};

export const sweepOrphans = async (
  deps: CliDeps,
  backend: Backend | undefined,
  options: SweepOptions = {},
): Promise<string[]> => {
  try {
    const swept = await sweepAll(deps, backend);
    const due = options.collect !== undefined || (await gcDue(deps));
    const collected = due ? await collectGarbage(deps, backend, options.collect?.sharedOwner) : [];

    return [...swept, ...collected];
  } catch (error) {
    warn(deps, "the sweep of leftover sandboxes failed", error);

    return [];
  }
};
