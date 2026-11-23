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
import type { Launch } from "./types.ts";

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

const entryFile = (stateDir: string, launchId: string) =>
  join(stateLayout(stateDir).launches, `${checkedLaunchId(launchId)}${ENTRY_SUFFIX}`);

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
  typeof value.launchId === "string" &&
  typeof value.repoHash === "string";

const readEntry = async (path: string): Promise<StoredEntry> => {
  const value = await readJsonObject(path);

  if (!isEntry(value)) {
    return { path, live: false };
  }

  return { path, entry: value, live: await isLive(value) };
};

const storedEntries = async (stateDir: string) => {
  const directory = stateLayout(stateDir).launches;
  const names = await readdir(directory).catch(() => []);

  return Promise.all(
    names.filter((name) => name.endsWith(ENTRY_SUFFIX)).map((name) => readEntry(join(directory, name))),
  );
};

const liveEntries = (stored: StoredEntry[]) =>
  stored.flatMap((item) => (item.live && item.entry !== undefined ? [item.entry] : []));

const deadEntries = (stored: StoredEntry[]) =>
  stored.flatMap((item) => (!item.live && item.entry !== undefined ? [item] : []));

export const pruneLaunches = async (stateDir: string): Promise<Launch[]> => {
  const stored = await storedEntries(stateDir);

  await Promise.all(deadEntries(stored).map((item) => rm(item.path, { force: true })));

  return liveEntries(stored);
};

export const liveLaunches = async (stateDir: string): Promise<Launch[]> =>
  liveEntries(await storedEntries(stateDir));

export const launchState = async (stateDir: string) => {
  const stored = await storedEntries(stateDir);

  return {
    live: liveEntries(stored),
    dead: deadEntries(stored).flatMap((item) => (item.entry === undefined ? [] : [item.entry])),
  };
};

export const othersLive = async (stateDir: string, repoHash: string, launchId?: string) =>
  (await liveLaunches(stateDir)).some((entry) => entry.repoHash === repoHash && entry.launchId !== launchId);

export const withLaunchLock = <T>(stateDir: string, action: () => Promise<T>) =>
  withFileLock(stateLayout(stateDir).launchesLock, action, { timeoutMs: LOCK_TIMEOUT_MS });

export const registerLaunch = (stateDir: string, entry: Launch) =>
  withLaunchLock(stateDir, async () => {
    await writeJsonFile(entryFile(stateDir, entry.launchId), entry, { mode: PRIVATE_MODE });

    await pruneLaunches(stateDir);
  });

export const endLaunch = (stateDir: string, launchId: string): Promise<Launch[]> =>
  withLaunchLock(stateDir, async () => {
    await rm(entryFile(stateDir, launchId), { force: true });

    return pruneLaunches(stateDir);
  });
