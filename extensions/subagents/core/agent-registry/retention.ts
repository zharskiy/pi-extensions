import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MANIFEST_FILE } from "../model/paths.ts";

const DAY_MS = 86_400_000;

type Retention = { sessionsRoot: string; retentionDays: number; keepSessions: string[]; now?: number };

const ignore = () => undefined;

const sessionKey = (file: string) => join(basename(dirname(file)), basename(file));

const subdirs = async (dir: string) => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
};

const isRealDir = (dir: string) =>
  lstat(dir).then(
    (stat) => stat.isDirectory(),
    () => false,
  );

const mtime = (path: string) =>
  lstat(path).then(
    (stat) => stat.mtimeMs,
    () => 0,
  );

const pruneRun = async (run: string, cutoff: number) => {
  try {
    const names = await readdir(run);

    if (!names.includes(MANIFEST_FILE)) {
      return false;
    }

    const stats = await Promise.all(
      [run, ...names.map((name) => join(run, name))].map((path) => lstat(path)),
    );
    const touched = Math.max(...stats.map((stat) => stat.mtimeMs));

    if (touched >= cutoff) {
      return false;
    }

    await rm(run, { recursive: true, force: true });

    return true;
  } catch {
    return false;
  }
};

const pruneAgentsDir = async (stem: string, cutoff: number) => {
  const agentsDir = join(stem, "agents");
  const sessionTouched = await mtime(`${stem}.jsonl`);

  if (sessionTouched >= cutoff || !(await isRealDir(agentsDir))) {
    return;
  }

  const runs = await subdirs(agentsDir);
  const removed = await Promise.all(runs.map((run) => pruneRun(run, cutoff)));

  if (!removed.includes(true)) {
    return;
  }

  await rmdir(agentsDir).catch(ignore);
  await rmdir(stem).catch(ignore);
};

export const pruneAgentRuns = async ({
  sessionsRoot,
  retentionDays,
  keepSessions,
  now = Date.now(),
}: Retention) => {
  if (retentionDays <= 0) {
    return;
  }

  const cutoff = now - retentionDays * DAY_MS;
  const kept = new Set(keepSessions.map(sessionKey));
  const slugs = await subdirs(sessionsRoot);
  const stems = await Promise.all(slugs.map(subdirs));

  await stems
    .flat()
    .filter((stem) => !kept.has(sessionKey(`${stem}.jsonl`)))
    .reduce((done, stem) => done.then(() => pruneAgentsDir(stem, cutoff)), Promise.resolve());
};
