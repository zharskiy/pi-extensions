import { randomBytes } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  isJsonObject,
  isLive,
  LauncherError,
  readJsonObject,
  stateLayout,
  withFileLock,
  writeJsonFile,
} from "../shared/index.ts";
import type { EndLaunchInput, Launch } from "./types.ts";

const LAUNCH_ID = /^[0-9a-f]{16}$/;

const ENTRY_SUFFIX = ".json";

const PRIVATE_MODE = 0o600;

const LOCK_TIMEOUT_MS = 120_000;

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
  typeof value.start === "string" &&
  typeof value.launchId === "string";

const readEntry = async (path: string): Promise<StoredEntry> => {
  const value = await readJsonObject(path);

  if (!isEntry(value)) {
    return { path, live: false };
  }

  return { path, entry: value, live: await isLive(value) };
};

const storedEntries = async (stateDir: string, repoHash: string) => {
  const directory = launchesDir(stateDir, repoHash);
  const names = await readdir(directory).catch(() => []);

  return Promise.all(
    names.filter((name) => name.endsWith(ENTRY_SUFFIX)).map((name) => readEntry(join(directory, name))),
  );
};

const liveEntries = (stored: StoredEntry[]) =>
  stored.flatMap((item) => (item.live && item.entry !== undefined ? [item.entry] : []));

const deadEntries = (stored: StoredEntry[]) =>
  stored.filter((item) => item.entry !== undefined && !item.live);

export const pruneLaunches = async (stateDir: string, repoHash: string): Promise<Launch[]> => {
  const stored = await storedEntries(stateDir, repoHash);

  await Promise.all(deadEntries(stored).map((item) => rm(item.path, { force: true })));

  return liveEntries(stored);
};

const repoHashes = async (stateDir: string) => {
  const entries = await readdir(stateLayout(stateDir).repos, { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

export const liveLaunches = async (stateDir: string, repoHash?: string): Promise<Launch[]> => {
  const hashes = repoHash === undefined ? await repoHashes(stateDir) : [repoHash];
  const entries = await Promise.all(hashes.map((hash) => storedEntries(stateDir, hash)));

  return entries.flatMap(liveEntries);
};

export const launchState = async (stateDir: string, repoHash: string) => {
  const stored = await storedEntries(stateDir, repoHash);

  return { live: liveEntries(stored), dead: deadEntries(stored).length };
};

export const othersLive = async (stateDir: string, repoHash: string, launchId?: string) =>
  (await liveLaunches(stateDir, repoHash)).some((entry) => entry.launchId !== launchId);

export const withRepoLaunchLock = <T>(stateDir: string, repoHash: string, action: () => Promise<T>) =>
  withFileLock(lockFile(stateDir, repoHash), action, { timeoutMs: LOCK_TIMEOUT_MS });

export const registerLaunch = (stateDir: string, entry: Launch): Promise<number> =>
  withRepoLaunchLock(stateDir, entry.repoHash, async () => {
    await writeJsonFile(entryFile(stateDir, entry.repoHash, entry.launchId), entry, { mode: PRIVATE_MODE });

    return (await pruneLaunches(stateDir, entry.repoHash)).length;
  });

export const endLaunch = (stateDir: string, input: EndLaunchInput): Promise<number> =>
  withRepoLaunchLock(stateDir, input.repoHash, async () => {
    await rm(entryFile(stateDir, input.repoHash, input.launchId), { force: true });

    const remaining = (await pruneLaunches(stateDir, input.repoHash)).length;

    if (remaining === 0) {
      await input.onLast();
    }

    return remaining;
  });
