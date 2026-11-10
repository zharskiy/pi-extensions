import { access, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LauncherError } from "./errors.ts";
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

export interface RepoRecord {
  root: string;
  mountPoint: boolean;
}

const isMountPoint = async (root: string) => {
  const [own, parent] = await Promise.all([stat(root), stat(dirname(root))]).catch(() => []);

  return own !== undefined && parent !== undefined && own.dev !== parent.dev;
};

export const writeRepoRecord = async (stateDir: string, repoHash: string, root: string) =>
  writeJsonFile(
    filesOf(stateDir, repoHash).record,
    { root, ...((await isMountPoint(root)) ? { mountPoint: true } : {}) },
    { mode: PRIVATE_MODE },
  );

export const repoRecordOf = async (stateDir: string, repoHash: string): Promise<RepoRecord | undefined> => {
  const record = await readJsonObject(filesOf(stateDir, repoHash).record);

  return typeof record?.root === "string"
    ? { root: record.root, mountPoint: record.mountPoint === true }
    : undefined;
};

export const knownRepos = async (stateDir: string) => {
  const entries = await readdir(stateLayout(stateDir).repos, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isDirectory() && REPO_HASH.test(entry.name))
    .map((entry) => entry.name);
};

const readList = async <T>(path: string, valid: (value: unknown) => value is T) => {
  const stored = await readJsonFile<unknown>(path);

  if (stored === undefined) {
    return [];
  }

  if (!Array.isArray(stored)) {
    throw new LauncherError(`${path}: not a list`, "fix or remove the file");
  }

  return stored.filter(valid);
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

const gitDirsFile = (stateDir: string, repoHash: string) =>
  join(filesOf(stateDir, repoHash).directory, "created-git.json");

export interface GitCreatedDir {
  dir: string;
  gitCommonDir?: string;
}

const gitCreatedOf = (value: unknown): GitCreatedDir[] => {
  if (typeof value === "string") {
    return [{ dir: value }];
  }

  if (!isJsonObject(value) || typeof value.dir !== "string") {
    return [];
  }

  return [
    typeof value.gitCommonDir === "string"
      ? { dir: value.dir, gitCommonDir: value.gitCommonDir }
      : { dir: value.dir },
  ];
};

const isGitCreated = (value: unknown): value is unknown => gitCreatedOf(value).length > 0;

export const readGitCreatedDirs = async (stateDir: string, repoHash: string): Promise<GitCreatedDir[]> =>
  (await readList(gitDirsFile(stateDir, repoHash), isGitCreated)).flatMap(gitCreatedOf);

export const writeCreatedDirs = async (stateDir: string, repoHash: string, dirs: string[]) => {
  const git = await readGitCreatedDirs(stateDir, repoHash);

  await writeList(
    gitDirsFile(stateDir, repoHash),
    git.filter((entry) => dirs.includes(entry.dir)),
  );

  await writeList(filesOf(stateDir, repoHash).created, dirs);
};

const recordGitDirs = async (stateDir: string, repoHash: string, added: GitCreatedDir[]) => {
  const known = await readGitCreatedDirs(stateDir, repoHash);
  const fresh = added.filter((entry) => !known.some((old) => old.dir === entry.dir));

  await writeList(gitDirsFile(stateDir, repoHash), [...known, ...fresh]);
};

export interface CreatedKind {
  gitCommonDir: string;
}

export const recordCreatedDirs = (stateDir: string, repoHash: string, dirs: string[], kind?: CreatedKind) =>
  queued(filesOf(stateDir, repoHash).created, async () => {
    if (dirs.length === 0) {
      return;
    }

    const known = await readCreatedDirs(stateDir, repoHash);

    if (kind !== undefined) {
      await recordGitDirs(
        stateDir,
        repoHash,
        dirs.map((dir) => ({ dir, gitCommonDir: kind.gitCommonDir })),
      );
    }

    await writeList(filesOf(stateDir, repoHash).created, [...new Set([...known, ...dirs])]);
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
