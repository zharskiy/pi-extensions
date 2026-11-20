import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { RUN_MANIFEST, runRules, runsDir } from "../../../platform/shared/index.ts";
import type { Sized } from "./handoff-scan.ts";
import { LIMIT, pooled } from "./pool.ts";
import { measure, subdirsIn } from "./real-dirs.ts";

export type Run = {
  id: string;
  dir: string;
  touched: number;
  bytes: number;
  keep: boolean;
  links: string[];
};

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const unreadable = (dir: string): Run => ({
  id: basename(dir),
  dir,
  touched: Number.POSITIVE_INFINITY,
  bytes: 0,
  keep: true,
  links: [],
});

const readRun = async (dir: string): Promise<Run> => {
  try {
    const names = await readdir(dir);

    if (!names.includes(RUN_MANIFEST)) {
      return unreadable(dir);
    }

    const { touched, bytes } = await measure(dir);
    const rules = runRules(parsed(await readFile(join(dir, RUN_MANIFEST), "utf8")));

    return { id: basename(dir), dir, touched, bytes, ...rules };
  } catch {
    return unreadable(dir);
  }
};

const gather = (runs: Map<string, Run>, id: string, chain: Set<Run>) => {
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

const expired = (runs: Map<string, Run>, run: Run, cutoff: number) =>
  Array.from(gather(runs, run.id, new Set())).every((link) => link.touched < cutoff && !link.keep);

export const readRuns = async (stems: readonly string[]) => {
  const dirs = await pooled(stems, LIMIT, (stem) => subdirsIn(runsDir(stem)));
  const runs = await pooled(dirs.flat(), LIMIT, readRun);
  const byDir = new Map(runs.map((run) => [run.dir, run]));

  return dirs.map((group) => group.flatMap((dir) => byDir.get(dir) ?? []));
};

export const staleRuns = (found: readonly Run[], cutoff: number): Sized[] => {
  const runs = new Map<string, Run>(found.map((run) => [run.id, run]));

  return Array.from(runs.values())
    .filter((run) => expired(runs, run, cutoff))
    .map(({ dir, bytes }) => ({ dir, bytes }));
};
