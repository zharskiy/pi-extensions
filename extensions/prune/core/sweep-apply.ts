import { lstat, rm, rmdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { AGENTS_DIR } from "./agent-runs.ts";
import { rootState } from "./handoff-root.ts";
import type { Sized } from "./handoff-scan.ts";
import { type Live, readLive } from "./live-markers.ts";
import { pathKey } from "./path-key.ts";
import { LIMIT, pooled } from "./pool.ts";
import type { Candidate, Plan, PlanInput, Removed, Stem } from "./sweep-plan.ts";

type Tally = { count: number; bytes: number };

type ApplyContext = Pick<PlanInput, "agentDir" | "handoffRoot" | "current" | "isAlive">;

const NOTHING: Removed = { sessions: 0, runs: 0, handoffs: 0, bytes: 0 };

const NONE: Tally = { count: 0, bytes: 0 };

const ignore = () => undefined;

const done = (work: Promise<unknown>) =>
  work.then(
    () => 1,
    () => 0,
  );

const tallied = (tallies: readonly Tally[]): Tally => ({
  count: tallies.reduce((total, tally) => total + tally.count, 0),
  bytes: tallies.reduce((total, tally) => total + tally.bytes, 0),
});

const added = (all: readonly Removed[]): Removed => ({
  sessions: all.reduce((total, removed) => total + removed.sessions, 0),
  runs: all.reduce((total, removed) => total + removed.runs, 0),
  handoffs: all.reduce((total, removed) => total + removed.handoffs, 0),
  bytes: all.reduce((total, removed) => total + removed.bytes, 0),
});

const removeSized = async ({ dir, bytes }: Sized): Promise<Tally> =>
  (await done(rm(dir, { recursive: true }))) === 1 ? { count: 1, bytes } : NONE;

const pruneStem = async ({ dir, runs }: Stem) => {
  const removed = tallied(await pooled(runs, 1, removeSized));

  if (removed.count > 0) {
    await rmdir(join(dir, AGENTS_DIR)).catch(ignore);
    await rmdir(dir).catch(ignore);
  }

  return removed;
};

const removeHandoff = async (handoff: Sized, context: ApplyContext) =>
  (await rootState(context.handoffRoot)) === "safe" ? removeSized(handoff) : NONE;

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

  return stat.mtimeMs === candidate.mtime ? stat.size : "stop";
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

    const state = await recheck(candidate, context).catch((): "stop" => "stop");

    if (state === "gone") {
      return NOTHING;
    }

    if (state === "stop" || (await done(unlink(candidate.file))) === 0) {
      stopped = true;
      return NOTHING;
    }

    const runs = candidate.stem ? await pruneStem(candidate.stem) : NONE;
    const handoff = candidate.handoff ? await removeHandoff(candidate.handoff, context) : NONE;

    return {
      sessions: 1,
      runs: runs.count,
      handoffs: handoff.count,
      bytes: state + runs.bytes + handoff.bytes,
    };
  };

  return pooled(chain, 1, step);
};

export const clearEmpties = async (plan: Plan, context: ApplyContext) => {
  const live = await readLive(context.agentDir, context.current, context.isAlive);

  if (!live) {
    return 0;
  }

  const cleared = await pooled(
    plan.empties.filter((dir) => !live.ids.has(basename(dir))),
    LIMIT,
    async (dir) => ((await rootState(context.handoffRoot)) === "safe" ? done(rmdir(dir)) : 0),
  );

  return cleared.reduce((total, count) => total + count, 0);
};

export const apply = async (plan: Plan, context: ApplyContext): Promise<Removed> => {
  if (plan.aborted) {
    return NOTHING;
  }

  const chains = await pooled(plan.chains, LIMIT, (chain) => removeChain(chain, context));
  const sessions = chains.flat();
  const stems = tallied(await pooled(plan.orphans.stems, LIMIT, pruneStem));
  const handoffs = tallied(
    await pooled(plan.orphans.handoffs, LIMIT, (handoff) => removeHandoff(handoff, context)),
  );

  await pooled(plan.markers, LIMIT, (marker) => done(unlink(marker)));

  return added([
    ...sessions,
    { sessions: 0, runs: stems.count, handoffs: handoffs.count, bytes: stems.bytes + handoffs.bytes },
  ]);
};
