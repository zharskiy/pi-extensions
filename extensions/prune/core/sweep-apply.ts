import { lstat, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AGENTS_DIR } from "./agent-runs.ts";
import { rootState } from "./handoff-root.ts";
import { type Live, readLive } from "./live-markers.ts";
import { pathKey } from "./path-key.ts";
import { LIMIT, pooled } from "./pool.ts";
import type { Candidate, Plan, PlanInput, Stem } from "./sweep-plan.ts";

export type Removed = { sessions: number; runs: number; handoffs: number };

type ApplyContext = Pick<PlanInput, "agentDir" | "handoffRoot" | "current" | "isAlive">;

const NOTHING: Removed = { sessions: 0, runs: 0, handoffs: 0 };

const ignore = () => undefined;

const done = (work: Promise<unknown>) =>
  work.then(
    () => 1,
    () => 0,
  );

const sum = (counts: number[]) => counts.reduce((total, count) => total + count, 0);

const removeDir = (dir: string) => done(rm(dir, { recursive: true }));

const pruneStem = async ({ dir, runs }: Stem) => {
  const removed = sum(await pooled(runs, 1, removeDir));

  if (removed > 0) {
    await rmdir(join(dir, AGENTS_DIR)).catch(ignore);
    await rmdir(dir).catch(ignore);
  }

  return removed;
};

const removeHandoff = async (dir: string, context: ApplyContext) =>
  (await rootState(context.handoffRoot)) === "safe" ? removeDir(dir) : 0;

const isLive = (candidate: Candidate, live: Live) =>
  live.ids.has(candidate.id) || live.files.has(pathKey(candidate.file));

const changed = async ({ file, mtime }: Candidate) => {
  const stat = await lstat(file).catch(ignore);

  return stat !== undefined && stat.mtimeMs !== mtime;
};

const untouched = async (chain: readonly Candidate[], context: ApplyContext) => {
  const live = await readLive(context.agentDir, context.current, context.isAlive);

  if (!live || chain.some((candidate) => isLive(candidate, live))) {
    return false;
  }

  const changes = await Promise.all(chain.map(changed));

  return !changes.includes(true);
};

const recheck = async (candidate: Candidate, context: ApplyContext) => {
  const live = await readLive(context.agentDir, context.current, context.isAlive);

  if (!live || isLive(candidate, live)) {
    return "stop";
  }

  const stat = await lstat(candidate.file).catch(ignore);

  if (!stat) {
    return "gone";
  }

  return stat.mtimeMs === candidate.mtime ? "same" : "stop";
};

const removeChain = async (chain: readonly Candidate[], context: ApplyContext): Promise<Removed[]> => {
  if (!(await untouched(chain, context).catch(() => false))) {
    return [];
  }

  let stopped = false;

  const step = async (candidate: Candidate): Promise<Removed> => {
    if (stopped) {
      return NOTHING;
    }

    const state = await recheck(candidate, context).catch(() => "stop");

    if (state === "gone") {
      return NOTHING;
    }

    if (state === "stop" || (await done(unlink(candidate.file))) === 0) {
      stopped = true;
      return NOTHING;
    }

    return {
      sessions: 1,
      runs: candidate.stem ? await pruneStem(candidate.stem) : 0,
      handoffs: candidate.handoff ? await removeHandoff(candidate.handoff, context) : 0,
    };
  };

  return pooled(chain, 1, step);
};

export const apply = async (plan: Plan, context: ApplyContext): Promise<Removed> => {
  if (plan.aborted) {
    return NOTHING;
  }

  const chains = await pooled(plan.chains, LIMIT, (chain) => removeChain(chain, context));
  const sessions = chains.flat();
  const stems = await pooled(plan.orphans.stems, LIMIT, pruneStem);
  const handoffs = await pooled(plan.orphans.handoffs, LIMIT, (dir) => removeHandoff(dir, context));

  await pooled(plan.markers, LIMIT, (marker) => done(unlink(marker)));

  return {
    sessions: sum(sessions.map((removed) => removed.sessions)),
    runs: sum([...sessions.map((removed) => removed.runs), ...stems]),
    handoffs: sum([...sessions.map((removed) => removed.handoffs), ...handoffs]),
  };
};
