import { access, readdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { LauncherError } from "./errors.ts";
import { readJsonFile, readJsonObject, writeJsonFile } from "./json-file.ts";
import { stateLayout } from "./state-layout.ts";

const PRIVATE_MODE = 0o600;

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
  mountRoot?: string;
}

const deviceOf = (path: string) =>
  stat(path).then(
    (info) => info.dev,
    () => undefined,
  );

export const isMounted = async (dir: string) => {
  const [own, parent] = await Promise.all([deviceOf(dir), deviceOf(dirname(dir))]);

  return own !== undefined && parent !== undefined && own !== parent;
};

const mountRootOf = async (dir: string): Promise<string | undefined> => {
  const parent = dirname(dir);

  if (parent === dir) {
    return undefined;
  }

  return (await isMounted(dir)) ? dir : mountRootOf(parent);
};

export const writeRepoRecord = async (stateDir: string, repoHash: string, root: string) => {
  const mountRoot = await mountRootOf(root);

  await writeJsonFile(
    filesOf(stateDir, repoHash).record,
    { root, ...(mountRoot === undefined ? {} : { mountRoot }) },
    { mode: PRIVATE_MODE },
  );
};

export const repoRecordOf = async (stateDir: string, repoHash: string): Promise<RepoRecord | undefined> => {
  const record = await readJsonObject(filesOf(stateDir, repoHash).record);

  if (typeof record?.root !== "string") {
    return undefined;
  }

  return typeof record.mountRoot === "string"
    ? { root: record.root, mountRoot: record.mountRoot }
    : { root: record.root };
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

const isPath = (value: unknown): value is string => typeof value === "string";

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

    await writeList(filesOf(stateDir, repoHash).created, [...new Set([...known, ...dirs])]);
  });

export const hasRepoLeftovers = async (stateDir: string, repoHash: string) => {
  const files = filesOf(stateDir, repoHash);
  const present = await Promise.all([files.proxy.record, files.proxy.token, files.created].map(exists));

  return present.some(Boolean);
};

export const forgetRepo = async (stateDir: string, repoHash: string) => {
  const files = filesOf(stateDir, repoHash);

  await rm(files.render, { recursive: true, force: true });

  await rm(files.directory, { recursive: true, force: true });
};
