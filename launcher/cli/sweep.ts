import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { type Backend, type ContainerSummary, LABELS, type VolumeSummary } from "../backend/index.ts";
import { discardContainer, listLauncherContainers, removeRepoContainers } from "../container/index.ts";
import {
  forgetRepoGrants,
  type Launch,
  launchState,
  pruneLaunches,
  withRepoLaunchLock,
} from "../grants/index.ts";
import { collectImages, removeBuildLeftovers } from "../image/index.ts";
import { removeRepoToken } from "../proxy/index.ts";
import {
  forgetRepo,
  hasRepoLeftovers,
  isMounted,
  knownRepos,
  PRIVATE_FILE_MODE,
  type RepoRecord,
  readCreatedDirs,
  readJsonObject,
  repoRecordOf,
  shortHash,
  stateLayout,
  writeCreatedDirs,
  writeJsonFile,
} from "../shared/index.ts";
import { removeCreatedDirs } from "../workspace/index.ts";
import { type CliDeps, pathsOf, writeWarning } from "./deps.ts";
import { sweepRepoSessions } from "./host-sessions.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const RELAYS = { [LABELS.relay]: "true" };

type Presence = "present" | "missing" | "unknown";

const presenceOf = (path: string): Promise<Presence> =>
  stat(path).then(
    () => "present",
    (error: unknown) => ((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown"),
  );

const rootState = async (record: RepoRecord | undefined) => {
  if (record === undefined) {
    return "present";
  }

  const own = await presenceOf(record.root);

  if (own !== "missing") {
    return own === "present" ? "present" : "unreachable";
  }

  if (record.mountRoot !== undefined && !(await isMounted(record.mountRoot))) {
    return "unreachable";
  }

  return (await presenceOf(dirname(record.root))) === "present" ? "gone" : "unreachable";
};

const removeRelays = async (backend: Backend, repoHash: string) => {
  const relays = await backend.findContainers({ ...RELAYS, [LABELS.repoHash]: repoHash });

  await Promise.all(relays.map((relay) => discardContainer(backend, relay)));

  return relays;
};

const removeEngineSide = async (backend: Backend, repoHash: string) => {
  const [containers, relays] = await Promise.all([
    removeRepoContainers(backend, repoHash),
    removeRelays(backend, repoHash),
  ]);
  const network = await backend.removeRepoNetwork(repoHash);

  return [
    ...containers.map((container) => `removed container ${container.name} (${container.id})`),
    ...relays.map((relay) => `removed relay ${relay.name}`),
    ...(network ? [`removed network of ${shortHash(repoHash)}`] : []),
  ];
};

const clearEngine = async (deps: CliDeps, engine: Backend | undefined, repoHash: string) => {
  if (engine === undefined) {
    return [];
  }

  try {
    return await removeEngineSide(engine, repoHash);
  } catch (error) {
    writeWarning(deps, "the sandbox containers were not removed", error);

    return [];
  }
};

const stopProxy = async (deps: CliDeps, stateDir: string, repoHash: string) => {
  const stopped = await deps.proxy.stop(stateDir, repoHash);

  await removeRepoToken(stateDir, repoHash);

  return stopped ? [`stopped the proxy of ${shortHash(repoHash)}`] : [];
};

export const removeRepoSandbox = async (deps: CliDeps, engine: Backend | undefined, repoHash: string) => {
  const stateDir = pathsOf(deps).stateDir;
  const [cleared, proxy] = await Promise.all([
    clearEngine(deps, engine, repoHash),
    stopProxy(deps, stateDir, repoHash),
  ]);

  await writeCreatedDirs(
    stateDir,
    repoHash,
    await removeCreatedDirs(await readCreatedDirs(stateDir, repoHash)),
  );

  const root = (await repoRecordOf(stateDir, repoHash))?.root;

  if (root !== undefined) {
    await sweepRepoSessions(deps, root, true);
  }

  return [...cleared, ...proxy];
};

const forget = async (stateDir: string, repoHash: string) => {
  await forgetRepo(stateDir, repoHash);

  await forgetRepoGrants(stateDir, repoHash);
};

const removeDeadLaunches = async (
  engine: Backend | undefined,
  agents: ContainerSummary[],
  live: Launch[],
) => {
  const liveIds = new Set(live.map((launch) => launch.launchId));
  const dead = agents.filter((agent) => !liveIds.has(agent.labels[LABELS.launchId] ?? ""));

  if (engine === undefined) {
    return [];
  }

  await Promise.all(dead.map((agent) => discardContainer(engine, agent).catch(() => undefined)));

  return dead.map((agent) => `removed container ${agent.name} (${agent.id}) of an ended launch`);
};

const sweepRepo = async (
  deps: CliDeps,
  engine: Backend | undefined,
  repoHash: string,
  agents: ContainerSummary[],
  inEngine: boolean,
) => {
  const stateDir = pathsOf(deps).stateDir;
  const launches = await launchState(stateDir, repoHash);

  if (launches.live.length > 0) {
    return removeDeadLaunches(engine, agents, launches.live);
  }

  const record = await repoRecordOf(stateDir, repoHash);
  const state = await rootState(record);
  const gone = state === "gone";
  const leftovers = inEngine || (await hasRepoLeftovers(stateDir, repoHash));

  if (state === "unreachable" || (!leftovers && !gone && launches.dead === 0)) {
    return [];
  }

  return withRepoLaunchLock(stateDir, repoHash, async () => {
    if ((await pruneLaunches(stateDir, repoHash)).length > 0) {
      return [];
    }

    const lines = leftovers ? await removeRepoSandbox(deps, engine, repoHash) : [];

    if (record === undefined && inEngine && (await repoRecordOf(stateDir, repoHash)) === undefined) {
      await forget(stateDir, repoHash);

      return lines;
    }

    if (!gone || record === undefined) {
      return lines;
    }

    await forget(stateDir, repoHash);

    return [...lines, `forgot ${record.root}, which no longer exists`];
  });
};

const repoHashOf = (summary: { labels: Record<string, string> }) => {
  const hash = summary.labels[LABELS.repoHash];

  return hash === undefined ? [] : [hash];
};

const engineObjects = async (engine: Backend | undefined) => {
  if (engine === undefined) {
    return { agents: [], hashes: [] };
  }

  const [agents, relays, networks] = await Promise.all([
    listLauncherContainers(engine),
    engine.findContainers(RELAYS),
    engine.listNetworks(),
  ]);

  return { agents, hashes: [...agents, ...relays, ...networks].flatMap(repoHashOf) };
};

const removedVolume = (backend: Backend, volume: VolumeSummary) =>
  backend.removeVolume(volume.name).then(
    () => [volume],
    () => [],
  );

const volumeRecord = async (stateDir: string, volume: VolumeSummary, root: string): Promise<RepoRecord> => {
  const hash = volume.labels[LABELS.repoHash];
  const record = hash === undefined ? undefined : await repoRecordOf(stateDir, hash);

  return record?.root === root ? record : { root };
};

const orphaned = async (stateDir: string, volume: VolumeSummary) => {
  const root = volume.labels[LABELS.repoRoot];

  return (
    root !== undefined &&
    !volume.inUse &&
    (await rootState(await volumeRecord(stateDir, volume, root))) === "gone"
  );
};

const pruneVolumes = async (stateDir: string, backend: Backend) => {
  const volumes = await backend.listVolumes();
  const verdicts = await Promise.all(volumes.map((volume) => orphaned(stateDir, volume)));
  const removed = await Promise.all(
    volumes.filter((_volume, index) => verdicts[index]).map((volume) => removedVolume(backend, volume)),
  );

  return removed.flat().map((volume) => `removed volume ${volume.name}`);
};

const gcDue = async (deps: CliDeps) => {
  const record = await readJsonObject(stateLayout(pathsOf(deps).stateDir).gcRecord);
  const lastRun = typeof record?.lastRun === "number" ? record.lastRun : 0;

  return deps.now() - lastRun >= DAY_MS;
};

const collectGarbage = async (deps: CliDeps, engine: Backend | undefined) => {
  const stateDir = pathsOf(deps).stateDir;

  if (engine === undefined) {
    return [];
  }

  const volumes = await pruneVolumes(stateDir, engine);
  const images = await collectImages(engine, stateDir);

  await writeJsonFile(stateLayout(stateDir).gcRecord, { lastRun: deps.now() }, { mode: PRIVATE_FILE_MODE });

  return [...volumes, ...images.map((image) => `removed image ${image}`)];
};

const sweepAll = async (deps: CliDeps, engine: Backend | undefined) => {
  const listed = await engineObjects(engine);
  const fromEngine = new Set(listed.hashes);
  const hashes = [...new Set([...fromEngine, ...(await knownRepos(pathsOf(deps).stateDir))])];
  const agentsOf = (hash: string) => listed.agents.filter((agent) => agent.labels[LABELS.repoHash] === hash);
  const lines = await Promise.all(
    hashes.map((hash) =>
      sweepRepo(deps, engine, hash, agentsOf(hash), fromEngine.has(hash)).catch((error: unknown) => {
        writeWarning(deps, `the sandbox of ${shortHash(hash)} was not swept`, error);

        return [];
      }),
    ),
  );

  return lines.flat();
};

export const sweepFailed = (deps: CliDeps, error: unknown): string[] => {
  writeWarning(deps, "the sweep of leftover sandboxes failed", error);

  return [];
};

export const sweepOrphans = async (deps: CliDeps, engine: Backend | undefined): Promise<string[]> => {
  try {
    const swept = await sweepAll(deps, engine);

    await removeBuildLeftovers(pathsOf(deps).stateDir);

    const collected = (await gcDue(deps)) ? await collectGarbage(deps, engine) : [];

    return [...swept, ...collected];
  } catch (error) {
    return sweepFailed(deps, error);
  }
};
