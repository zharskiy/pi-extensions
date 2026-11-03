import { lstat, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentRecord } from "../model/agent-record.ts";
import { MANIFEST_FILE } from "../model/paths.ts";

const DAY_MS = 86_400_000;

type Retention = { sessionsRoot: string; retentionDays: number; keepSessions: string[]; now?: number };

type Manifest = Partial<Pick<AgentRecord, "predecessorId" | "successorId" | "worktree">> | null;

type Run = { id: string; dir: string; touched: number; spared: boolean; links: unknown[] };

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

const parsed = (text: string): Manifest => {
  try {
    return JSON.parse(text) as Manifest;
  } catch {
    return null;
  }
};

const keepsWorktree = (manifest: Manifest) => {
  const worktree = manifest?.worktree;

  return Boolean(worktree) && worktree?.cleanup !== "removed";
};

const readRun = async (dir: string): Promise<Run[]> => {
  try {
    const names = await readdir(dir);

    if (!names.includes(MANIFEST_FILE)) {
      return [];
    }

    const stats = await Promise.all(
      [dir, ...names.map((name) => join(dir, name))].map((path) => lstat(path)),
    );
    const manifest = parsed(await readFile(join(dir, MANIFEST_FILE), "utf8"));

    return [
      {
        id: basename(dir),
        dir,
        touched: Math.max(...stats.map((stat) => stat.mtimeMs)),
        spared: keepsWorktree(manifest),
        links: [manifest?.predecessorId, manifest?.successorId],
      },
    ];
  } catch {
    return [];
  }
};

const gather = (runs: Map<unknown, Run>, id: unknown, chain: Set<Run>) => {
  const run = runs.get(id);

  if (!run || chain.has(run)) {
    return chain;
  }

  chain.add(run);
  run.links.forEach((link) => {
    gather(runs, link, chain);
  });

  return chain;
};

const expired = (runs: Map<unknown, Run>, run: Run, cutoff: number) =>
  Array.from(gather(runs, run.id, new Set())).every((link) => link.touched < cutoff && !link.spared);

const removeRun = (run: Run) =>
  rm(run.dir, { recursive: true, force: true }).then(
    () => true,
    () => false,
  );

const pruneAgentsDir = async (stem: string, cutoff: number) => {
  const agentsDir = join(stem, "agents");
  const sessionTouched = await mtime(`${stem}.jsonl`);

  if (sessionTouched >= cutoff || !(await isRealDir(agentsDir))) {
    return;
  }

  const found = await Promise.all((await subdirs(agentsDir)).map(readRun));
  const runs = new Map<unknown, Run>(found.flat().map((run) => [run.id, run]));
  const stale = Array.from(runs.values()).filter((run) => expired(runs, run, cutoff));
  const removed = await Promise.all(stale.map(removeRun));

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
