import { readdir } from "node:fs/promises";
import { basename, extname, join, posix } from "node:path";
import { isSecretName, lstatOrUndefined, readRegularFile } from "../shared/index.ts";
import { inPool } from "./pool.ts";

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

const SECRET_DIRS = new Set(["secrets", ".secrets", "credentials", ".credentials"]);

const PACKAGE_DIR = "node_modules";

const isSecretDir = (name: string, relative: string) =>
  SECRET_DIRS.has(name.toLowerCase()) && !relative.split("/").includes(PACKAGE_DIR);

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

interface Candidate {
  path: string;
  relative: string;
}

interface Found {
  files: Candidate[];
  skipped: string[];
}

const NOTHING: Found = { files: [], skipped: [] };

const PARALLEL_READS = 16;

const candidates = async (path: string, relative: string, topLevel: boolean): Promise<Found> => {
  const info = await lstatOrUndefined(path);

  if (info === undefined || info.isSymbolicLink()) {
    return NOTHING;
  }

  if (info.isDirectory() && !topLevel && SKIPPED_DIRS.has(basename(path))) {
    return NOTHING;
  }

  if (info.isDirectory() && !topLevel && isSecretDir(basename(path), relative)) {
    return { files: [], skipped: [relative] };
  }

  if (info.isDirectory()) {
    const names = (await readdir(path)).sort();
    const nested = await Promise.all(
      names.map((name) => candidates(join(path, name), posix.join(relative, name), false)),
    );

    return {
      files: nested.flatMap((found) => found.files),
      skipped: nested.flatMap((found) => found.skipped),
    };
  }

  const excluded = !topLevel && isExcludedName(basename(path));

  return !info.isFile() || info.size > MAX_FILE_BYTES || excluded
    ? NOTHING
    : { files: [{ path, relative }], skipped: [] };
};

const readCandidate = async (candidate: Candidate): Promise<[string, TreeFile] | undefined> => {
  const file = await readRegularFile(candidate.path).catch(() => undefined);

  return file === undefined || holdsPrivateKey(basename(candidate.path), file.data)
    ? undefined
    : [candidate.relative, { data: file.data, mode: modeOf(file.mode) }];
};

const skippedNotice = (relative: string) =>
  `render: ${relative} looks like a secrets directory and stays out of the sandbox`;

export const readHostEntries = async (
  hostAgentDir: string,
  names: readonly string[],
): Promise<{ tree: Tree; notices: string[] }> => {
  const found = await Promise.all(names.map((name) => candidates(join(hostAgentDir, name), name, true)));
  const files = await inPool(
    found.flatMap((entry) => entry.files),
    PARALLEL_READS,
    readCandidate,
  );

  return {
    tree: new Map(files.filter((file): file is [string, TreeFile] => file !== undefined)),
    notices: found.flatMap((entry) => entry.skipped).map(skippedNotice),
  };
};
