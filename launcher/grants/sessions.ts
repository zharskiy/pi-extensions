import { randomBytes } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isProcessAlive, LauncherError, stateLayout, withFileLock, writeJsonFile } from "../shared/index.ts";
import type { EndSessionInput, SessionEntry } from "./types.ts";

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

const entryFile = (stateDir: string, repoHash: string, launchId: string) =>
  join(stateLayout(stateDir).sessionsOf(repoHash), `${checkedLaunchId(launchId)}${ENTRY_SUFFIX}`);

const lockFile = (stateDir: string, repoHash: string) =>
  join(stateLayout(stateDir).sessionsOf(repoHash), "lock");

const readEntry = async (path: string) => {
  try {
    const entry = JSON.parse(await readFile(path, "utf8")) as SessionEntry;

    return typeof entry.pid === "number" && typeof entry.launchId === "string" ? entry : undefined;
  } catch {
    return undefined;
  }
};

const repoEntries = async (stateDir: string, repoHash: string) => {
  const directory = stateLayout(stateDir).sessionsOf(repoHash);
  const names = await readdir(directory).catch(() => []);
  const entries = await Promise.all(
    names.filter((name) => name.endsWith(ENTRY_SUFFIX)).map((name) => readEntry(join(directory, name))),
  );

  return entries.filter((entry): entry is SessionEntry => entry !== undefined);
};

const repoHashes = async (stateDir: string) => {
  const entries = await readdir(stateLayout(stateDir).sessions, { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

export const liveSessions = async (
  stateDir: string,
  repoHash?: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<SessionEntry[]> => {
  const hashes = repoHash === undefined ? await repoHashes(stateDir) : [repoHash];
  const entries = await Promise.all(hashes.map((hash) => repoEntries(stateDir, hash)));

  return entries.flat().filter((entry) => isAlive(entry.pid));
};

export const registerSession = (stateDir: string, entry: SessionEntry): Promise<number> =>
  withFileLock(lockFile(stateDir, entry.repoHash), async () => {
    await writeJsonFile(entryFile(stateDir, entry.repoHash, entry.launchId), entry, { mode: PRIVATE_MODE });

    return (await liveSessions(stateDir, entry.repoHash)).length;
  });

export const endSession = (stateDir: string, input: EndSessionInput): Promise<number> =>
  withFileLock(lockFile(stateDir, input.repoHash), async () => {
    await rm(entryFile(stateDir, input.repoHash, input.launchId), { force: true });

    const remaining = (await liveSessions(stateDir, input.repoHash)).length;

    if (remaining === 0) {
      await input.onLast();
    }

    return remaining;
  });

export const withRepoSessionLock = <T>(stateDir: string, repoHash: string, action: () => Promise<T>) =>
  withFileLock(lockFile(stateDir, repoHash), action);
