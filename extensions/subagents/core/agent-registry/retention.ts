import { lstat, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isPlainObject } from "../../../../platform/shared/index.ts";
import { type AgentState, isClosed } from "../model/agent-record.ts";
import { MANIFEST_FILE } from "../model/paths.ts";

const DAY_MS = 86_400_000;

type Retention = { sessionsRoot: string; retentionDays: number; keep: string[]; now?: number };

const subdirs = async (dir: string) => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
};

const isRealDir = (dir: string) =>
  lstat(dir).then(
    (stat) => stat.isDirectory(),
    () => false,
  );

const readManifest = (dir: string) =>
  readFile(join(dir, MANIFEST_FILE), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);

const newestMtime = async (dir: string) => {
  const names = await readdir(dir);
  const stats = await Promise.all([dir, ...names.map((name) => join(dir, name))].map((path) => lstat(path)));

  return Math.max(...stats.map((stat) => stat.mtimeMs));
};

const lastActive = async (run: string) => {
  const manifest = await readManifest(run);

  if (!isPlainObject(manifest) || typeof manifest.state !== "string") {
    return newestMtime(run);
  }

  if (!isClosed(manifest.state as AgentState)) {
    return undefined;
  }

  return typeof manifest.endedAt === "number" ? manifest.endedAt : newestMtime(run);
};

const pruneRun = async (run: string, cutoff: number) => {
  try {
    const active = await lastActive(run);

    if (active === undefined || active >= cutoff) {
      return [];
    }

    await rm(run, { recursive: true, force: true });

    return [run];
  } catch {
    return [];
  }
};

const pruneAgentsDir = async (agentsDir: string, cutoff: number) => {
  if (!(await isRealDir(agentsDir))) {
    return [];
  }

  const runs = await subdirs(agentsDir);
  const removed = await Promise.all(runs.map((run) => pruneRun(run, cutoff)));

  await rmdir(agentsDir).catch(() => undefined);
  await rmdir(dirname(agentsDir)).catch(() => undefined);

  return removed.flat();
};

const inSequence = (dirs: string[], step: (dir: string) => Promise<string[]>) =>
  dirs.reduce<Promise<string[]>>(
    async (done, dir) => [...(await done), ...(await step(dir))],
    Promise.resolve([]),
  );

export const pruneAgentRuns = async ({ sessionsRoot, retentionDays, keep, now = Date.now() }: Retention) => {
  if (retentionDays <= 0) {
    return [];
  }

  const cutoff = now - retentionDays * DAY_MS;
  const kept = new Set(keep.map((dir) => resolve(dir)));
  const slugs = await subdirs(sessionsRoot);
  const stems = await Promise.all(slugs.map(subdirs));

  const agentsDirs = stems
    .flat()
    .map((stem) => join(stem, "agents"))
    .filter((dir) => !kept.has(resolve(dir)));

  return inSequence(agentsDirs, (dir) => pruneAgentsDir(dir, cutoff));
};
