import { stat } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { type Backend, LABELS, type VolumeSummary } from "../backend/index.ts";
import {
  discardContainer,
  gitDirInUseElsewhere,
  listLauncherContainers,
  removeRepoContainers,
} from "../container/index.ts";
import { launchState, pruneLaunches, withRepoLaunchLock } from "../grants/index.ts";
import { collectImages, removeBuildLeftovers } from "../image/index.ts";
import { removeRepoToken } from "../proxy/index.ts";
import {
  errorMessage,
  forgetRepo,
  type GitCreatedDir,
  hasRepoLeftovers,
  isWithin,
  knownRepos,
  type PinRecord,
  type RepoRecord,
  readCreatedDirs,
  readGitCreatedDirs,
  readJsonObject,
  readPins,
  removeGitCopies,
  repoRecordOf,
  sha256Hex,
  shortHash,
  stateLayout,
  withFileLock,
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

const PIN_LOCK_TIMEOUT_MS = 120_000;

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

  if (record.mountPoint) {
    return "unreachable";
  }

  return (await presenceOf(dirname(record.root))) === "present" ? "gone" : "unreachable";
};

const warn = (deps: CliDeps, what: string, error: unknown) => {
  writeLine(deps.stderr, `pi-sandbox: warning: ${what}: ${errorMessage(error)}`);
};

const reachable = async (backend: Backend | undefined) =>
  backend !== undefined && (await backend.detect()).available ? backend : undefined;

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

interface Engine {
  reachable?: Backend;
  stopped: boolean;
}

const engineOf = async (backend: Backend | undefined): Promise<Engine> => ({
  reachable: await reachable(backend),
  stopped: backend === undefined,
});

interface EngineSide {
  lines: string[];
  held: boolean;
}

const clearEngine = async (deps: CliDeps, engine: Engine, repoHash: string): Promise<EngineSide> => {
  if (engine.reachable === undefined) {
    return { lines: [], held: !engine.stopped };
  }

  try {
    return { lines: await removeEngineSide(engine.reachable, repoHash), held: false };
  } catch (error) {
    warn(deps, "the sandbox containers were not removed", error);

    return { lines: [], held: true };
  }
};

const stopProxy = async (deps: CliDeps, stateDir: string, repoHash: string) => {
  const stopped = await deps.proxy.stop(stateDir, repoHash);

  await removeRepoToken(stateDir, repoHash);

  return stopped ? [`stopped the proxy of ${shortHash(repoHash)}`] : [];
};

type GitDirInUse = (gitCommonDir: string) => Promise<boolean>;

const inUseOf =
  (engine: Engine, repoHash: string, held: boolean): GitDirInUse =>
  async (gitCommonDir) => {
    if (held) {
      return true;
    }

    const backend = engine.reachable;

    return backend !== undefined && gitDirInUseElsewhere(backend, repoHash, gitCommonDir).catch(() => true);
  };

const releasePins = async (deps: CliDeps, repoHash: string, pins: PinRecord[], inUse: GitDirInUse) => {
  const stateDir = pathsOf(deps).stateDir;
  const { kept, notices } = await unpinRecorded(stateDir, pins, inUse);

  await writePins(stateDir, repoHash, kept);

  writeNotices(deps, notices);
};

const dotGitDirOf = (path: string) => {
  const parts = path.split(sep);
  const index = parts.indexOf(".git");

  return index === -1 ? undefined : parts.slice(0, index + 1).join(sep);
};

const gitDirOf = (path: string, gitCommonDirs: string[]) =>
  gitCommonDirs.find((dir) => isWithin(path, dir)) ?? dotGitDirOf(path);

const withGitDirLock = <T>(stateDir: string, gitCommonDir: string, action: () => Promise<T>) =>
  withFileLock(stateLayout(stateDir).gitPinLock(sha256Hex(gitCommonDir)), action, {
    timeoutMs: PIN_LOCK_TIMEOUT_MS,
  });

const OWNER_UNKNOWN = "";

const ownerOf = (dir: string, gitCommonDirs: string[], marked: GitCreatedDir[]) => {
  const entry = marked.find((candidate) => candidate.dir === dir);

  return (
    entry?.gitCommonDir ?? gitDirOf(dir, gitCommonDirs) ?? (entry === undefined ? undefined : OWNER_UNKNOWN)
  );
};

const groupedByGitDir = (dirs: string[], gitCommonDirs: string[], marked: GitCreatedDir[]) =>
  dirs.reduce((groups, dir) => {
    const gitDir = ownerOf(dir, gitCommonDirs, marked);

    return groups.set(gitDir, [...(groups.get(gitDir) ?? []), dir]);
  }, new Map<string | undefined, string[]>());

const anyInUse = async (gitCommonDirs: string[], inUse: GitDirInUse) =>
  gitCommonDirs.length === 0 || (await Promise.all(gitCommonDirs.map(inUse))).some(Boolean);

const removeCreated = async (stateDir: string, repoHash: string, pins: PinRecord[], inUse: GitDirInUse) => {
  const gitCommonDirs = [...new Set(pins.map((pin) => pin.gitCommonDir))];
  const groups = groupedByGitDir(
    await readCreatedDirs(stateDir, repoHash),
    gitCommonDirs,
    await readGitCreatedDirs(stateDir, repoHash),
  );
  const released = async (gitDir: string | undefined, dirs: string[]) => {
    if (gitDir === undefined) {
      return removeCreatedDirs(dirs);
    }

    if (gitDir === OWNER_UNKNOWN) {
      return (await anyInUse(gitCommonDirs, inUse)) ? dirs : removeCreatedDirs(dirs);
    }

    return withGitDirLock(stateDir, gitDir, async () =>
      (await inUse(gitDir)) ? dirs : removeCreatedDirs(dirs),
    );
  };
  const kept = await Promise.all([...groups].map(([gitDir, dirs]) => released(gitDir, dirs)));

  await writeCreatedDirs(stateDir, repoHash, kept.flat());
};

const removeSandbox = async (deps: CliDeps, engine: Engine, repoHash: string) => {
  const stateDir = pathsOf(deps).stateDir;
  const [cleared, proxy] = await Promise.all([
    clearEngine(deps, engine, repoHash),
    stopProxy(deps, stateDir, repoHash),
  ]);
  const pins = await readPins(stateDir, repoHash);
  const inUse = inUseOf(engine, repoHash, cleared.held);

  await releasePins(deps, repoHash, pins, inUse);

  await removeCreated(stateDir, repoHash, pins, inUse);

  await removeGitCopies(stateDir, repoHash);

  const root = (await repoRecordOf(stateDir, repoHash))?.root;

  if (root !== undefined) {
    await sweepRepoSessions(deps, root, true);
  }

  return [...cleared.lines, ...proxy];
};

export const removeRepoSandbox = async (deps: CliDeps, backend: Backend | undefined, repoHash: string) =>
  removeSandbox(deps, await engineOf(backend), repoHash);

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

const sweepRepo = async (deps: CliDeps, engine: Engine, repoHash: string, inEngine: boolean) => {
  const stateDir = pathsOf(deps).stateDir;
  const launches = await launchState(stateDir, repoHash);

  if (launches.live.length > 0) {
    return [];
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

    const lines = leftovers ? await removeSandbox(deps, engine, repoHash) : [];

    if (record === undefined && inEngine && (await repoRecordOf(stateDir, repoHash)) === undefined) {
      await forgetRepo(stateDir, repoHash);

      return lines;
    }

    if (!gone || record === undefined) {
      return lines;
    }

    await forgetRepo(stateDir, repoHash);

    return [
      ...lines,
      ...(await removeRepoVolumes(engine.reachable, repoHash)),
      `forgot ${record.root}, which no longer exists`,
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

const volumeRecord = async (stateDir: string, volume: VolumeSummary, root: string): Promise<RepoRecord> => {
  const hash = volume.labels[LABELS.repoHash];
  const record = hash === undefined ? undefined : await repoRecordOf(stateDir, hash);

  return record?.root === root ? record : { root, mountPoint: false };
};

const orphaned = async (stateDir: string, volume: VolumeSummary) => {
  const root = volume.labels[LABELS.repoRoot];

  return (
    root !== undefined &&
    !volume.inUse &&
    (await rootState(await volumeRecord(stateDir, volume, root))) === "gone"
  );
};

const sharedBy = (volume: VolumeSummary, userHash: string | undefined) =>
  userHash !== undefined && volume.labels[LABELS.userHash] === userHash;

const sharedLabel = (volume: VolumeSummary) => volume.labels[LABELS.sharedPath] ?? "unknown path";

const pruneVolumes = async (stateDir: string, backend: Backend, sharedOwner: string | undefined) => {
  const volumes = await backend.listVolumes();
  const verdicts = await Promise.all(volumes.map((volume) => orphaned(stateDir, volume)));
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
  const stateDir = pathsOf(deps).stateDir;
  const engine = await reachable(backend);

  if (engine === undefined) {
    return [];
  }

  const volumes = await pruneVolumes(stateDir, engine, sharedOwner);
  const images = await collectImages(engine, stateDir);

  await writeJsonFile(stateLayout(stateDir).gcRecord, { lastRun: deps.now() });

  return [...volumes, ...images.map((image) => `removed image ${image}`)];
};

const sweepAll = async (deps: CliDeps, backend: Backend | undefined) => {
  const engine = await engineOf(backend);
  const fromEngine = new Set(await engineRepos(engine.reachable));
  const hashes = [...new Set([...fromEngine, ...(await knownRepos(pathsOf(deps).stateDir))])];
  const lines = await Promise.all(
    hashes.map((hash) =>
      sweepRepo(deps, engine, hash, fromEngine.has(hash)).catch((error: unknown) => {
        warn(deps, `the sandbox of ${shortHash(hash)} was not swept`, error);

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

    await removeBuildLeftovers(pathsOf(deps).stateDir);

    const due = options.collect !== undefined || (await gcDue(deps));
    const collected = due ? await collectGarbage(deps, backend, options.collect?.sharedOwner) : [];

    return [...swept, ...collected];
  } catch (error) {
    warn(deps, "the sweep of leftover sandboxes failed", error);

    return [];
  }
};
