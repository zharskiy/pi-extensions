import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, extname, join, posix } from "node:path";
import { isSecretName } from "../shared/index.ts";

export interface TreeFile {
  data: Buffer;
  mode: number;
}

export type Tree = Map<string, TreeFile>;

export const MAX_FILE_BYTES = 8 * 1024 * 1024;

const EXECUTABLE_BITS = 0o111;

const FILE_MODE = 0o644;

const EXECUTABLE_MODE = 0o755;

const KEY_MATERIAL = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);

const DATA_FILE = new Set(["", ".json", ".txt", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf"]);

const SECRET_FILES = new Set(["auth.json", "mcp-auth.json", ".npmrc", ".netrc", ".pypirc"]);

const isExcludedFile = (name: string) => {
  const extension = extname(name).toLowerCase();

  return (
    SECRET_FILES.has(name.toLowerCase()) ||
    name.toLowerCase().startsWith(".env") ||
    KEY_MATERIAL.has(extension) ||
    (DATA_FILE.has(extension) && isSecretName(name))
  );
};

const modeOf = (mode: number) => ((mode & EXECUTABLE_BITS) === 0 ? FILE_MODE : EXECUTABLE_MODE);

const walk = async (path: string, relative: string, tree: Tree, topLevel: boolean): Promise<void> => {
  const info = await lstat(path).catch(() => undefined);

  if (info === undefined || info.isSymbolicLink()) {
    return;
  }

  if (info.isDirectory()) {
    const names = (await readdir(path)).sort();

    await names.reduce(
      (previous, name) =>
        previous.then(() => walk(join(path, name), posix.join(relative, name), tree, false)),
      Promise.resolve(),
    );

    return;
  }

  const excluded = !topLevel && isExcludedFile(basename(path));

  if (info.isFile() && info.size <= MAX_FILE_BYTES && !excluded) {
    tree.set(relative, { data: await readFile(path), mode: modeOf(info.mode) });
  }
};

export const readHostEntries = async (hostAgentDir: string, names: readonly string[]) => {
  const tree: Tree = new Map();

  await names.reduce(
    (previous, name) => previous.then(() => walk(join(hostAgentDir, name), name, tree, true)),
    Promise.resolve(),
  );

  return tree;
};
