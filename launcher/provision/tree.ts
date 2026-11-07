import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, extname, join, posix } from "node:path";
import { isSecretName } from "../shared/index.ts";

interface TreeFile {
  data: Buffer;
  mode: number;
}

export type Tree = Map<string, TreeFile>;

const MAX_FILE_BYTES = 8 * 1024 * 1024;

const EXECUTABLE_BITS = 0o111;

const FILE_MODE = 0o644;

const EXECUTABLE_MODE = 0o755;

const KEY_MATERIAL = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);

const SECRET_FILES = new Set([
  "auth.json",
  "mcp-auth.json",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
]);

const SKIPPED_DIRS = new Set([".git"]);

const SOURCE_FILES = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".md", ".css", ".html"]);

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

const isExcludedName = (name: string) => {
  const lower = name.toLowerCase();

  return (
    SECRET_FILES.has(lower) ||
    lower.startsWith(".env") ||
    lower.startsWith("id_") ||
    KEY_MATERIAL.has(extname(lower)) ||
    (!SOURCE_FILES.has(extname(lower)) && isSecretName(name))
  );
};

const holdsPrivateKey = (name: string, data: Buffer) =>
  extname(name).toLowerCase() === ".crt" && PRIVATE_KEY.test(data.toString("latin1"));

const modeOf = (mode: number) => ((mode & EXECUTABLE_BITS) === 0 ? FILE_MODE : EXECUTABLE_MODE);

const walk = async (path: string, relative: string, tree: Tree, topLevel: boolean): Promise<void> => {
  const info = await lstat(path).catch(() => undefined);

  if (info === undefined || info.isSymbolicLink()) {
    return;
  }

  if (info.isDirectory() && !topLevel && SKIPPED_DIRS.has(basename(path))) {
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

  const excluded = !topLevel && isExcludedName(basename(path));

  if (!info.isFile() || info.size > MAX_FILE_BYTES || excluded) {
    return;
  }

  const data = await readFile(path);

  if (!holdsPrivateKey(basename(path), data)) {
    tree.set(relative, { data, mode: modeOf(info.mode) });
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
