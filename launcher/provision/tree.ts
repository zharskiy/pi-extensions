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
  left: string[];
}

const NOTHING: Found = { files: [], skipped: [], left: [] };

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
    return { ...NOTHING, skipped: [relative] };
  }

  if (info.isDirectory()) {
    const names = (await readdir(path)).sort();
    const nested = await Promise.all(
      names.map((name) => candidates(join(path, name), posix.join(relative, name), false)),
    );

    return {
      files: nested.flatMap((found) => found.files),
      skipped: nested.flatMap((found) => found.skipped),
      left: nested.flatMap((found) => found.left),
    };
  }

  if (!info.isFile()) {
    return NOTHING;
  }

  if (!topLevel && isExcludedName(basename(path))) {
    return { ...NOTHING, left: [`${relative} (secret-looking name)`] };
  }

  return info.size > MAX_FILE_BYTES
    ? { ...NOTHING, left: [`${relative} (over 8 MiB)`] }
    : { ...NOTHING, files: [{ path, relative }] };
};

type Read = { file: [string, TreeFile] } | { left?: string };

const readCandidate = async (candidate: Candidate): Promise<Read> => {
  const file = await readRegularFile(candidate.path).catch(() => undefined);

  if (file === undefined) {
    return {};
  }

  return holdsPrivateKey(basename(candidate.path), file.data)
    ? { left: `${candidate.relative} (private key)` }
    : { file: [candidate.relative, { data: file.data, mode: modeOf(file.mode) }] };
};

const skippedNotice = (relative: string) =>
  `render: ${relative} looks like a secrets directory and stays out of the sandbox`;

const leftNotice = (left: string[]) =>
  left.length === 0 ? [] : [`render: left out of the sandbox: ${left.join(", ")}`];

export const readHostEntries = async (
  hostAgentDir: string,
  names: readonly string[],
): Promise<{ tree: Tree; notices: string[] }> => {
  const found = await Promise.all(names.map((name) => candidates(join(hostAgentDir, name), name, true)));
  const reads = await inPool(
    found.flatMap((entry) => entry.files),
    PARALLEL_READS,
    readCandidate,
  );
  const left = [
    ...found.flatMap((entry) => entry.left),
    ...reads.flatMap((read) => ("left" in read && read.left !== undefined ? [read.left] : [])),
  ];

  return {
    tree: new Map(reads.flatMap((read) => ("file" in read ? [read.file] : []))),
    notices: [...found.flatMap((entry) => entry.skipped).map(skippedNotice), ...leftNotice(left)],
  };
};
