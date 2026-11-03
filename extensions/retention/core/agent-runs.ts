import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { lastTouched, subdirsIn } from "./real-dirs.ts";
import { serial } from "./serial.ts";

export const AGENTS_DIR = "agents";

const MANIFEST_FILE = "manifest.json";

type Manifest = { predecessorId?: unknown; successorId?: unknown; worktree?: { cleanup?: unknown } } | null;

type Run = { id: string; dir: string; touched: number; spared: boolean; links: unknown[] };

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

const unreadable = (dir: string): Run => ({
  id: basename(dir),
  dir,
  touched: Number.POSITIVE_INFINITY,
  spared: true,
  links: [],
});

const readRun = async (dir: string): Promise<Run> => {
  try {
    const names = await readdir(dir);

    if (!names.includes(MANIFEST_FILE)) {
      return unreadable(dir);
    }

    const touched = await lastTouched(dir);
    const manifest = parsed(await readFile(join(dir, MANIFEST_FILE), "utf8"));

    return {
      id: basename(dir),
      dir,
      touched,
      spared: keepsWorktree(manifest),
      links: [manifest?.predecessorId, manifest?.successorId],
    };
  } catch {
    return unreadable(dir);
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

export const staleRuns = async (stem: string, cutoff: number) => {
  const found = await serial(await subdirsIn(join(stem, AGENTS_DIR)), readRun);
  const runs = new Map<unknown, Run>(found.map((run) => [run.id, run]));

  return Array.from(runs.values())
    .filter((run) => expired(runs, run, cutoff))
    .map((run) => run.dir);
};
