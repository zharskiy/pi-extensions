import { readdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { readJsonObject, writeJsonFile } from "./json-file.ts";
import { stateLayout } from "./state-layout.ts";

const PRIVATE_MODE = 0o600;

const REPO_HASH = /^[0-9a-f]{64}$/;

const filesOf = (stateDir: string, repoHash: string) => stateLayout(stateDir).repo(repoHash);

export interface RepoRecord {
  root: string;
  mountRoot?: string;
  workspaceRoot?: string;
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

export const writeRepoRecord = async (
  stateDir: string,
  repoHash: string,
  root: string,
  workspaceRoot?: string,
) => {
  const mountRoot = await mountRootOf(root);
  const record = {
    root,
    ...(mountRoot === undefined ? {} : { mountRoot }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  };

  await writeJsonFile(filesOf(stateDir, repoHash).record, record, { mode: PRIVATE_MODE });
};

export const repoRecordOf = async (stateDir: string, repoHash: string): Promise<RepoRecord | undefined> => {
  const record = await readJsonObject(filesOf(stateDir, repoHash).record);

  if (typeof record?.root !== "string") {
    return undefined;
  }

  const mountRoot = typeof record.mountRoot === "string" ? { mountRoot: record.mountRoot } : {};
  const workspaceRoot =
    typeof record.workspaceRoot === "string" ? { workspaceRoot: record.workspaceRoot } : {};

  return { root: record.root, ...mountRoot, ...workspaceRoot };
};

export const knownRepos = async (stateDir: string) => {
  const entries = await readdir(stateLayout(stateDir).repos, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isDirectory() && REPO_HASH.test(entry.name))
    .map((entry) => entry.name);
};

export const forgetRepo = (stateDir: string, repoHash: string) =>
  rm(filesOf(stateDir, repoHash).directory, { recursive: true, force: true });
