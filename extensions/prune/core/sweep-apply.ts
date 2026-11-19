import { lstat, rm, rmdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { AGENTS_DIR } from "./agent-runs.ts";
import { rootState } from "./handoff-root.ts";
import type { Sized } from "./handoff-scan.ts";
import { type Live, readLive } from "./live-markers.ts";
import { pathKey } from "./path-key.ts";
import { LIMIT, pooled } from "./pool.ts";
import type { Candidate, Plan, Removed, Sources, Stem } from "./sweep-plan.ts";

const NOTHING: Removed = { sessions: 0, runs: 0, handoffs: 0, bytes: 0 };

const ignore = () => undefined;

const done = (work: Promise<unknown>) =>
  work.then(
    () => 1,
    () => 0,
  );

const added = (all: readonly Removed[]): Removed => ({
  sessions: all.reduce((total, removed) => total + removed.sessions, 0),
  runs: all.reduce((total, removed) => total + removed.runs, 0),
  handoffs: all.reduce((total, removed) => total + removed.handoffs, 0),
  bytes: all.reduce((total, removed) => total + removed.bytes, 0),
});

const removeSized = async ({ dir, bytes }: Sized, kind: "runs" | "handoffs"): Promise<Removed> =>
  (await done(rm(dir, { recursive: true }))) === 1 ? { ...NOTHING, [kind]: 1, bytes } : NOTHING;

const pruneStem = async ({ dir, runs }: Stem) => {
  const removed = added(await pooled(runs, 1, (run) => removeSized(run, "runs")));

  if (removed.runs > 0) {
    await rmdir(join(dir, AGENTS_DIR)).catch(ignore);
    await rmdir(dir).catch(ignore);
  }

  return removed;
};

const removeHandoff = async (handoff: Sized, context: Sources) =>
  (await rootState(context.handoffRoot)) === "safe" ? removeSized(handoff, "handoffs") : NOTHING;

const isLive = (candidate: Candidate, live: Live) =>
  live.ids.has(candidate.id) || live.files.has(pathKey(candidate.file));

const changed = async ({ file, mtime }: Candidate) => {
  const stat = await lstat(file).catch(ignore);

  return stat !== undefined && stat.mtimeMs !== mtime;
};

const untouched = async (chain: readonly Candidate[], context: Sources) => {
  const live = await readLive(context.agentDir, context.current, context.isAlive);

  if (!live || chain.some((candidate) => isLive(candidate, live))) {
    return false;
  }

  const changes = await Promise.all(chain.map(changed));

  return !changes.includes(true);
};

const recheck = async (candidate: Candidate, context: Sources) => {
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

const removeChain = async (chain: readonly Candidate[], context: Sources): Promise<Removed[]> => {
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

    const runs = candidate.stem ? await pruneStem(candidate.stem) : NOTHING;
    const handoff = candidate.handoff ? await removeHandoff(candidate.handoff, context) : NOTHING;

    return added([{ ...NOTHING, sessions: 1, bytes: state }, runs, handoff]);
  };

  return pooled(chain, 1, step);
};

export const clearEmpties = async (plan: Plan, context: Sources) => {
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

export const apply = async (plan: Plan, context: Sources): Promise<Removed> => {
  if (plan.aborted) {
    return NOTHING;
  }

  const chains = await pooled(plan.chains, LIMIT, (chain) => removeChain(chain, context));
  const sessions = chains.flat();
  const stems = await pooled(plan.orphans.stems, LIMIT, pruneStem);
  const handoffs = await pooled(plan.orphans.handoffs, LIMIT, (handoff) => removeHandoff(handoff, context));

  await pooled(plan.markers, LIMIT, (marker) => done(unlink(marker)));

  return added([...sessions, ...stems, ...handoffs]);
};
