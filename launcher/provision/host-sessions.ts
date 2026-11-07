import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Backend } from "../backend/index.ts";
import { errorMessage, isWithin, PI_SESSION_DIR_VARIABLE } from "../shared/index.ts";
import { collector } from "./volume.ts";

interface SweepInput {
  dir: string;
  repoRoot: string;
  full: boolean;
}

interface EntryOutcome {
  removed: number;
  notices: string[];
  failures: string[];
}

type Removal = { removed: number; failures: string[] };

type Verdict = { keep: true } | { keep: false; reason: string };

interface Scan {
  decoder: StringDecoder;
  pending: string;
  scanned: number;
}

const PRIVATE_DIR = 0o700;

const HEADER_LIMIT = 1024 * 1024;

const CHUNK_SIZE = 64 * 1024;

const PARALLEL_FILES = 8;

const MIB = 1024 * 1024;

const LARGE_FILE_MIB = 256;

const SESSION_SUFFIX = ".jsonl";

const REJECTED_SUFFIX = ".rejected";

const OWNER_ACCESS = 0o700;

const MODE_BITS = 0o7777;

const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

const PROBE_SCRIPT = [
  `test "$${PI_SESSION_DIR_VARIABLE}" = "$1"`,
  'test -f "$1/$2"',
  ': > "$1/$2.guest"',
  'rm "$1/$2.guest"',
].join(" && ");

const NOTHING: EntryOutcome = { removed: 0, notices: [], failures: [] };

const NO_REMOVAL: Removal = { removed: 0, failures: [] };

const KEEP: Verdict = { keep: true };

export const prepareHostSessions = async (dir: string) => {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
};

const lstatOrUndefined = (path: string) => lstat(path).catch(() => undefined);

const isSpecial = (info: Stats) => !info.isFile() && !info.isDirectory();

const sameEntry = async (path: string, info: Stats) => {
  const again = await lstatOrUndefined(path);

  return again !== undefined && again.dev === info.dev && again.ino === info.ino;
};

const stuck = (path: string, what: string) => `${path} is ${what} and could be neither renamed nor deleted`;

const removeSpecial = async (path: string, info: Stats): Promise<Removal> => {
  if (!(await sameEntry(path, info))) {
    return NO_REMOVAL;
  }

  return unlink(path).then(
    () => ({ removed: 1, failures: [] }),
    () => ({ removed: 0, failures: [stuck(path, "a link or special file")] }),
  );
};

const ownerAccess = async (dir: string, info: Stats) => {
  if (info.uid !== process.getuid?.() || (info.mode & OWNER_ACCESS) === OWNER_ACCESS) {
    return;
  }

  await chmod(dir, (info.mode & MODE_BITS) | OWNER_ACCESS).catch(() => undefined);
};

const parsedEntry = (line: string): unknown => {
  if (line.trim() === "") {
    return undefined;
  }

  try {
    return JSON.parse(line) || undefined;
  } catch {
    return undefined;
  }
};

const headerVerdict = (entry: unknown, repoRoot: string): Verdict => {
  const header = entry as { type?: unknown; cwd?: unknown };

  if (header.type !== "session") {
    return KEEP;
  }

  const cwd = header.cwd;

  return typeof cwd === "string" && isAbsolute(cwd) && isWithin(cwd, repoRoot)
    ? KEEP
    : { keep: false, reason: "names a cwd outside the repository" };
};

const hasBareReturn = (line: string) => line.replace(/\r$/, "").includes("\r");

const BARE_RETURN: Verdict = { keep: false, reason: "has a bare carriage return before its session header" };

const decide = (lines: string[], repoRoot: string): Verdict | undefined => {
  const index = lines.findIndex((line) => parsedEntry(line) !== undefined);
  const examined = index === -1 ? lines : lines.slice(0, index + 1);

  if (examined.some(hasBareReturn)) {
    return BARE_RETURN;
  }

  return index === -1 ? undefined : headerVerdict(parsedEntry(lines[index] ?? ""), repoRoot);
};

const readChunk = async (handle: FileHandle) => {
  const buffer = Buffer.alloc(CHUNK_SIZE);
  const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, null);

  return buffer.subarray(0, bytesRead);
};

const scanHeader = async (handle: FileHandle, repoRoot: string, scan: Scan): Promise<Verdict> => {
  const chunk = await readChunk(handle);

  if (chunk.length === 0) {
    return decide([scan.pending + scan.decoder.end()], repoRoot) ?? KEEP;
  }

  const lines = (scan.pending + scan.decoder.write(chunk)).split("\n");
  const pending = lines.pop() ?? "";
  const verdict = decide(lines, repoRoot);
  const scanned = scan.scanned + chunk.length;

  if (verdict !== undefined) {
    return verdict;
  }

  if (scanned >= HEADER_LIMIT) {
    return { keep: false, reason: "has no session header within 1 MiB" };
  }

  return scanHeader(handle, repoRoot, { decoder: scan.decoder, pending, scanned });
};

const readVerdict = async (path: string, info: Stats, repoRoot: string): Promise<Verdict | undefined> => {
  const handle = await open(path, READ_FLAGS);

  try {
    const opened = await handle.stat();

    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      return undefined;
    }

    return await scanHeader(handle, repoRoot, {
      decoder: new StringDecoder("utf8"),
      pending: "",
      scanned: 0,
    });
  } finally {
    await handle.close();
  }
};

const isGone = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const verdictOf = (path: string, info: Stats, repoRoot: string): Promise<Verdict | undefined> =>
  readVerdict(path, info, repoRoot).catch((error: unknown) =>
    isGone(error) ? undefined : { keep: false, reason: `could not be read (${errorMessage(error)})` },
  );

const rejectedName = (path: string) => `${path}${REJECTED_SUFFIX}-${randomBytes(4).toString("hex")}`;

const rejectFile = async (path: string, info: Stats, reason: string): Promise<EntryOutcome> => {
  if (!(await sameEntry(path, info))) {
    return NOTHING;
  }

  const target = rejectedName(path);
  const renamed = await rename(path, target).then(
    () => true,
    () => false,
  );

  if (renamed) {
    return { ...NOTHING, notices: [`sessions: ${path} ${reason}; renamed to ${basename(target)}`] };
  }

  const removed =
    (await sameEntry(path, info)) &&
    (await unlink(path).then(
      () => true,
      () => false,
    ));

  return removed
    ? { ...NOTHING, notices: [`sessions: ${path} ${reason}; it could not be renamed and was deleted`] }
    : { ...NOTHING, failures: [stuck(path, `a session file that ${reason}`)] };
};

const checkFile = async (path: string, info: Stats, repoRoot: string): Promise<EntryOutcome> => {
  const large = info.size > LARGE_FILE_MIB * MIB ? [`sessions: ${path} is over ${LARGE_FILE_MIB} MiB`] : [];

  if (!path.endsWith(SESSION_SUFFIX)) {
    return { ...NOTHING, notices: large };
  }

  const verdict = await verdictOf(path, info, repoRoot);
  const rejected =
    verdict === undefined || verdict.keep ? NOTHING : await rejectFile(path, info, verdict.reason);

  return { ...rejected, notices: [...large, ...rejected.notices] };
};

const combined = (removals: Removal[]): Removal => ({
  removed: removals.reduce((total, removal) => total + removal.removed, 0),
  failures: removals.flatMap((removal) => removal.failures),
});

const unreadable = (dir: string): Removal => ({ removed: 0, failures: [`${dir} could not be listed`] });

const sweepTree = async (dir: string, info: Stats): Promise<Removal> => {
  await ownerAccess(dir, info);

  const names = await readdir(dir).catch(() => undefined);

  if (names === undefined) {
    return unreadable(dir);
  }

  const removals = await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      const entry = await lstatOrUndefined(path);

      if (entry === undefined) {
        return NO_REMOVAL;
      }

      if (entry.isDirectory()) {
        return sweepTree(path, entry);
      }

      return isSpecial(entry) ? removeSpecial(path, entry) : NO_REMOVAL;
    }),
  );

  return combined(removals);
};

const sweepEntry = async (input: SweepInput, name: string): Promise<EntryOutcome> => {
  const path = join(input.dir, name);
  const info = await lstatOrUndefined(path);

  if (info === undefined) {
    return NOTHING;
  }

  if (isSpecial(info)) {
    return { ...NOTHING, ...(await removeSpecial(path, info)) };
  }

  if (info.isFile()) {
    return checkFile(path, info, input.repoRoot);
  }

  return input.full ? { ...NOTHING, ...(await sweepTree(path, info)) } : NOTHING;
};

const inBatches = async <T, R>(items: T[], size: number, action: (item: T) => Promise<R>): Promise<R[]> => {
  if (items.length === 0) {
    return [];
  }

  const done = await Promise.all(items.slice(0, size).map(action));

  return [...done, ...(await inBatches(items.slice(size), size, action))];
};

const removedNotice = (dir: string, removed: number) =>
  removed === 0 ? [] : [`sessions: removed ${removed} links or special files from ${dir}`];

export const sweepHostSessions = async (input: SweepInput) => {
  const root = await lstatOrUndefined(input.dir);

  if (root === undefined || !root.isDirectory()) {
    return { notices: [], failures: [] };
  }

  await ownerAccess(input.dir, root);

  const names = await readdir(input.dir).catch(() => undefined);

  if (names === undefined) {
    return { notices: [], failures: unreadable(input.dir).failures };
  }

  const outcomes = await inBatches(names, PARALLEL_FILES, (name) => sweepEntry(input, name));
  const removed = outcomes.reduce((total, outcome) => total + outcome.removed, 0);

  return {
    notices: [...outcomes.flatMap((outcome) => outcome.notices), ...removedNotice(input.dir, removed)],
    failures: outcomes.flatMap((outcome) => outcome.failures),
  };
};

export const probeHostSessions = async (backend: Backend, containerId: string, dir: string) => {
  const marker = `.pi-sandbox-probe-${randomBytes(6).toString("hex")}`;
  const path = join(dir, marker);

  await writeFile(path, "", { flag: "wx", mode: 0o600 });

  try {
    const code = await backend.exec(
      { containerId, command: ["sh", "-c", PROBE_SCRIPT, "sh", dir, marker], env: {}, workdir: "/" },
      { stdout: collector().stream, stderr: collector().stream, tty: false },
    );

    return code === 0;
  } finally {
    await rm(path, { force: true });

    await rm(`${path}.guest`, { force: true });
  }
};
