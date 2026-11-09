import { access, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isJsonObject, readJsonFile, readJsonObject, writeJsonFile } from "./json-file.ts";
import { stateLayout } from "./state-layout.ts";

export interface PinRecord {
  path: string;
  gitCommonDir: string;
}

const PRIVATE_MODE = 0o600;

const GIT_COPY = /^[0-9a-f]{16}$/;

const REPO_HASH = /^[0-9a-f]{64}$/;

const queues = new Map<string, Promise<void>>();

const filesOf = (stateDir: string, repoHash: string) => stateLayout(stateDir).repo(repoHash);

const queued = (path: string, step: () => Promise<void>) => {
  const next = (queues.get(path) ?? Promise.resolve()).catch(() => undefined).then(step);

  queues.set(path, next);

  return next;
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

export const writeRepoRecord = (stateDir: string, repoHash: string, root: string) =>
  writeJsonFile(filesOf(stateDir, repoHash).record, { root }, { mode: PRIVATE_MODE });

export const repoRootOf = async (stateDir: string, repoHash: string) => {
  const record = await readJsonObject(filesOf(stateDir, repoHash).record);

  return typeof record?.root === "string" ? record.root : undefined;
};

export const knownRepos = async (stateDir: string) => {
  const entries = await readdir(stateLayout(stateDir).repos, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isDirectory() && REPO_HASH.test(entry.name))
    .map((entry) => entry.name);
};

const readList = async <T>(path: string, valid: (value: unknown) => value is T) => {
  const stored = await readJsonFile<unknown>(path).catch(() => undefined);

  return Array.isArray(stored) ? stored.filter(valid) : [];
};

const writeList = async <T>(path: string, values: T[]) => {
  if (values.length === 0) {
    await rm(path, { force: true });

    return;
  }

  await writeJsonFile(path, values, { mode: PRIVATE_MODE });
};

const isPin = (value: unknown): value is PinRecord =>
  isJsonObject(value) && typeof value.path === "string" && typeof value.gitCommonDir === "string";

const isPath = (value: unknown): value is string => typeof value === "string";

export const readPins = (stateDir: string, repoHash: string) =>
  readList(filesOf(stateDir, repoHash).pins, isPin);

export const writePins = (stateDir: string, repoHash: string, pins: PinRecord[]) =>
  writeList(filesOf(stateDir, repoHash).pins, pins);

export const recordPins = (stateDir: string, repoHash: string, pins: PinRecord[]) =>
  queued(filesOf(stateDir, repoHash).pins, async () => {
    if (pins.length === 0) {
      return;
    }

    const known = await readPins(stateDir, repoHash);
    const added = pins.filter((pin) => !known.some((entry) => entry.path === pin.path));

    await writePins(stateDir, repoHash, [...known, ...added]);
  });

export const readCreatedDirs = (stateDir: string, repoHash: string) =>
  readList(filesOf(stateDir, repoHash).created, isPath);

export const writeCreatedDirs = (stateDir: string, repoHash: string, dirs: string[]) =>
  writeList(filesOf(stateDir, repoHash).created, dirs);

export const recordCreatedDirs = (stateDir: string, repoHash: string, dirs: string[]) =>
  queued(filesOf(stateDir, repoHash).created, async () => {
    if (dirs.length === 0) {
      return;
    }

    const known = await readCreatedDirs(stateDir, repoHash);

    await writeCreatedDirs(stateDir, repoHash, [...new Set([...known, ...dirs])]);
  });

const gitCopies = async (stateDir: string, repoHash: string) => {
  const directory = filesOf(stateDir, repoHash).git;
  const names = await readdir(directory).catch(() => [] as string[]);

  return names.filter((name) => GIT_COPY.test(name)).map((name) => join(directory, name));
};

export const removeGitCopies = async (stateDir: string, repoHash: string) => {
  const copies = await gitCopies(stateDir, repoHash);

  await Promise.all(copies.map((path) => rm(path, { force: true })));
};

export const hasRepoLeftovers = async (stateDir: string, repoHash: string) => {
  const files = filesOf(stateDir, repoHash);
  const present = await Promise.all(
    [files.proxy.record, files.proxy.token, files.pins, files.created].map(exists),
  );

  return present.some(Boolean) || (await gitCopies(stateDir, repoHash)).length > 0;
};

export const forgetRepo = (stateDir: string, repoHash: string) =>
  rm(filesOf(stateDir, repoHash).directory, { recursive: true, force: true });
