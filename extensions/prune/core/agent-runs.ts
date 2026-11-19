import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Sized } from "./handoff-scan.ts";
import { LIMIT, pooled } from "./pool.ts";
import { measure, subdirsIn } from "./real-dirs.ts";

export const AGENTS_DIR = "agents";

const MANIFEST_FILE = "manifest.json";

type Manifest = { predecessorId?: unknown; successorId?: unknown; worktree?: { cleanup?: unknown } } | null;

export type Run = {
  id: string;
  dir: string;
  touched: number;
  bytes: number;
  spared: boolean;
  links: unknown[];
};

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
  bytes: 0,
  spared: true,
  links: [],
});

const readRun = async (dir: string): Promise<Run> => {
  try {
    const names = await readdir(dir);

    if (!names.includes(MANIFEST_FILE)) {
      return unreadable(dir);
    }

    const { touched, bytes } = await measure(dir);
    const manifest = parsed(await readFile(join(dir, MANIFEST_FILE), "utf8"));

    return {
      id: basename(dir),
      dir,
      touched,
      bytes,
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

export const readRuns = async (stems: readonly string[]) => {
  const dirs = await pooled(stems, LIMIT, (stem) => subdirsIn(join(stem, AGENTS_DIR)));
  const runs = await pooled(dirs.flat(), LIMIT, readRun);
  const byDir = new Map(runs.map((run) => [run.dir, run]));

  return dirs.map((group) => group.flatMap((dir) => byDir.get(dir) ?? []));
};

export const staleRuns = (found: readonly Run[], cutoff: number): Sized[] => {
  const runs = new Map<unknown, Run>(found.map((run) => [run.id, run]));

  return Array.from(runs.values())
    .filter((run) => expired(runs, run, cutoff))
    .map(({ dir, bytes }) => ({ dir, bytes }));
};
