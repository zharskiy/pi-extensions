import { randomBytes } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  heartbeat,
  isJsonObject,
  isLive,
  LauncherError,
  readJsonObject,
  stateLayout,
  withFileLock,
  writeJsonFile,
} from "../shared/index.ts";
import type { EndLaunchInput, Launch, RegisteredLaunch } from "./types.ts";

const LAUNCH_ID = /^[0-9a-f]{16}$/;

const ENTRY_SUFFIX = ".json";

const PRIVATE_MODE = 0o600;

export const newLaunchId = (): string => randomBytes(8).toString("hex");

const checkedLaunchId = (launchId: string) => {
  if (!LAUNCH_ID.test(launchId)) {
    throw new LauncherError(`invalid launch id ${launchId}`);
  }

  return launchId;
};

const launchesDir = (stateDir: string, repoHash: string) => stateLayout(stateDir).repo(repoHash).launches;

const entryFile = (stateDir: string, repoHash: string, launchId: string) =>
  join(launchesDir(stateDir, repoHash), `${checkedLaunchId(launchId)}${ENTRY_SUFFIX}`);

const lockFile = (stateDir: string, repoHash: string) => stateLayout(stateDir).repo(repoHash).lock;

interface StoredEntry {
  path: string;
  entry?: Launch;
  live: boolean;
}

const isEntry = (value: unknown): value is Launch =>
  isJsonObject(value) &&
  typeof value.pid === "number" &&
  typeof value.boot === "number" &&
  typeof value.launchId === "string";

const readEntry = async (path: string, now: number): Promise<StoredEntry> => {
  const [value, info] = await Promise.all([readJsonObject(path), stat(path).catch(() => undefined)]);

  if (!isEntry(value) || info === undefined) {
    return { path, live: false };
  }

  return { path, entry: value, live: isLive(value, info.mtimeMs, now) };
};

const storedEntries = async (stateDir: string, repoHash: string, now = Date.now()) => {
  const directory = launchesDir(stateDir, repoHash);
  const names = await readdir(directory).catch(() => []);

  return Promise.all(
    names.filter((name) => name.endsWith(ENTRY_SUFFIX)).map((name) => readEntry(join(directory, name), now)),
  );
};

const liveEntries = (stored: StoredEntry[]) =>
  stored.flatMap((item) => (item.live && item.entry !== undefined ? [item.entry] : []));

const pruneDead = async (stateDir: string, repoHash: string) => {
  const stored = await storedEntries(stateDir, repoHash);
  const dead = stored.filter((item) => item.entry !== undefined && !item.live);

  await Promise.all(dead.map((item) => rm(item.path, { force: true })));

  return liveEntries(stored);
};

const repoHashes = async (stateDir: string) => {
  const entries = await readdir(stateLayout(stateDir).repos, { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

export const liveLaunches = async (stateDir: string, repoHash?: string, now?: number): Promise<Launch[]> => {
  const hashes = repoHash === undefined ? await repoHashes(stateDir) : [repoHash];
  const entries = await Promise.all(hashes.map((hash) => storedEntries(stateDir, hash, now)));

  return entries.flatMap(liveEntries);
};

export const registerLaunch = async (stateDir: string, entry: Launch): Promise<RegisteredLaunch> => {
  const path = entryFile(stateDir, entry.repoHash, entry.launchId);
  const live = await withFileLock(lockFile(stateDir, entry.repoHash), async () => {
    await writeJsonFile(path, entry, { mode: PRIVATE_MODE });

    return (await pruneDead(stateDir, entry.repoHash)).length;
  });

  return { live, stopHeartbeat: heartbeat(path) };
};

export const endLaunch = (stateDir: string, input: EndLaunchInput): Promise<number> =>
  withFileLock(lockFile(stateDir, input.repoHash), async () => {
    await rm(entryFile(stateDir, input.repoHash, input.launchId), { force: true });

    const remaining = (await pruneDead(stateDir, input.repoHash)).length;

    if (remaining === 0) {
      await input.onLast();
    }

    return remaining;
  });

export const withRepoLaunchLock = <T>(stateDir: string, repoHash: string, action: () => Promise<T>) =>
  withFileLock(lockFile(stateDir, repoHash), action);
