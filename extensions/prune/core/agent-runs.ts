import { readFile, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  fallbackStemsRoot,
  RUN_MANIFEST,
  runRules,
  runsDir,
  sessionStem,
} from "../../../platform/shared/index.ts";
import { pathKey } from "./path-key.ts";
import { pooled } from "./pool.ts";
import { measure, type Sized, subdirsIn } from "./real-dirs.ts";

export type Run = Sized & { id: string; touched: number; keep: boolean; links: string[] };

export const SESSION_EXT = ".jsonl";

type Stem = { dir: string; listed: boolean };

type Found = { files: readonly string[]; stems: readonly Stem[]; live: Set<string>; kept: Set<string> };

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
    const rules = runRules(parsed(await readFile(join(dir, RUN_MANIFEST), "utf8")));
    const { touched, bytes } = await measure(dir);

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

const readRuns = async (stems: readonly string[]) => {
  const dirs = await pooled(stems, (stem) => subdirsIn(runsDir(stem)));
  const runs = await pooled(dirs.flat(), readRun);
  const byDir = new Map(runs.map((run) => [run.dir, run]));

  return dirs.map((group) => group.flatMap((dir) => byDir.get(dir) ?? []));
};

export const scanRuns = async (agentDir: string, found: Found) => {
  const stemDirs = new Set(found.stems.map(({ dir }) => pathKey(dir)));
  const reading = found.files.filter((file) => stemDirs.has(pathKey(sessionStem(file))));
  const fallbacks = (await subdirsIn(fallbackStemsRoot(agentDir))).filter(
    (dir) => !found.kept.has(basename(dir)),
  );
  const orphans = found.stems.filter(
    ({ dir, listed }) => !listed && !found.live.has(pathKey(`${dir}${SESSION_EXT}`)),
  );
  const runs = await readRuns(reading.map(sessionStem));
  const fallbackRuns = await readRuns(fallbacks);

  return {
    runs: new Map(reading.map((file, index) => [file, runs[index]] as const)),
    orphanRuns: await readRuns(orphans.map(({ dir }) => dir)),
    fallbackRuns: new Map(fallbacks.map((dir, index) => [basename(dir), fallbackRuns[index]] as const)),
  };
};

export const staleRuns = (found: readonly Run[], cutoff: number): Sized[] => {
  const runs = new Map(found.map((run) => [run.id, run]));

  return Array.from(runs.values())
    .filter((run) => expired(runs, run, cutoff))
    .map(({ dir, bytes }) => ({ dir, bytes }));
};

const ignore = () => undefined;

export const removeRun = async ({ dir }: Sized) => {
  const removed = await rm(dir, { recursive: true }).then(
    () => true,
    () => false,
  );

  if (removed) {
    await rmdir(dirname(dir)).catch(ignore);
    await rmdir(dirname(dirname(dir))).catch(ignore);
  }

  return removed;
};
