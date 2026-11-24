import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, posix } from "node:path";
import { isSecretName, lstatOrUndefined, readRegularFile } from "../shared/index.ts";
import { inPool } from "./pool.ts";

interface TreeFile {
  data: Buffer;
  mode: number;
}

export type Tree = Map<string, TreeFile>;

export interface HostSource {
  path: string;
  key: string;
  label: string;
  agentsSkillsRoot?: string;
}

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
  key: string;
  label: string;
}

interface Found {
  files: Candidate[];
  skipped: string[];
  left: string[];
  linked: string[];
}

const NOTHING: Found = { files: [], skipped: [], left: [], linked: [] };

const PARALLEL_READS = 16;

const isAgentsSkillLink = async (path: string, source: HostSource, rest: string) => {
  const root = source.agentsSkillsRoot;

  if (root === undefined || rest.includes("/")) {
    return false;
  }

  const target = await realpath(path).catch(() => undefined);
  const info = target === undefined ? undefined : await stat(target).catch(() => undefined);

  return target !== undefined && info?.isDirectory() === true && dirname(target) === root;
};

const candidates = async (source: HostSource, path: string, rest: string): Promise<Found> => {
  const info = await lstatOrUndefined(path);

  if (info === undefined) {
    return NOTHING;
  }

  const topLevel = rest === "";
  const key = posix.join(source.key, rest);
  const label = posix.join(source.label, rest);

  if (info.isSymbolicLink()) {
    return (await isAgentsSkillLink(path, source, rest)) ? NOTHING : { ...NOTHING, linked: [label] };
  }

  if (info.isDirectory() && !topLevel && SKIPPED_DIRS.has(basename(path))) {
    return NOTHING;
  }

  if (info.isDirectory() && !topLevel && isSecretDir(basename(path), key)) {
    return { ...NOTHING, skipped: [label] };
  }

  if (info.isDirectory()) {
    const names = (await readdir(path)).sort();
    const nested = await Promise.all(
      names.map((name) => candidates(source, join(path, name), posix.join(rest, name))),
    );

    return {
      files: nested.flatMap((found) => found.files),
      skipped: nested.flatMap((found) => found.skipped),
      left: nested.flatMap((found) => found.left),
      linked: nested.flatMap((found) => found.linked),
    };
  }

  if (!info.isFile()) {
    return NOTHING;
  }

  if (!topLevel && isExcludedName(basename(path))) {
    return { ...NOTHING, left: [`${label} (secret-looking name)`] };
  }

  return info.size > MAX_FILE_BYTES
    ? { ...NOTHING, left: [`${label} (over 8 MiB)`] }
    : { ...NOTHING, files: [{ path, key, label }] };
};

type Read = { file: [string, TreeFile] } | { left?: string };

const readCandidate = async (candidate: Candidate): Promise<Read> => {
  const file = await readRegularFile(candidate.path).catch(() => undefined);

  if (file === undefined) {
    return {};
  }

  return holdsPrivateKey(basename(candidate.path), file.data)
    ? { left: `${candidate.label} (private key)` }
    : { file: [candidate.key, { data: file.data, mode: modeOf(file.mode) }] };
};

const skippedNotice = (relative: string) =>
  `render: ${relative} looks like a secrets directory and stays out of the sandbox`;

const leftNotice = (left: string[]) =>
  left.length === 0 ? [] : [`render: left out of the sandbox: ${left.join(", ")}`];

const linkedNotice = (linked: string[]) =>
  linked.length === 0
    ? []
    : [
        `render: missing in the sandbox, because pinata follows no symlinks: ${linked.join(", ")}; replace each link with a real directory or file to carry it`,
      ];

export const readHostEntries = async (sources: HostSource[]): Promise<{ tree: Tree; notices: string[] }> => {
  const found = await Promise.all(sources.map((source) => candidates(source, source.path, "")));
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
    notices: [
      ...found.flatMap((entry) => entry.skipped).map(skippedNotice),
      ...leftNotice(left),
      ...linkedNotice(found.flatMap((entry) => entry.linked)),
    ],
  };
};
