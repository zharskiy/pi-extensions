import { lstat, rm, rmdir, unlink } from "node:fs/promises";
import { removeRun } from "./agent-runs.ts";
import { isLive, type Live } from "./live-markers.ts";
import { pooled } from "./pool.ts";
import type { Sized } from "./real-dirs.ts";
import type { Candidate, Plan, Removed } from "./sweep-plan.ts";

type Lives = () => Promise<Live | undefined>;

const NOTHING: Removed = { sessions: 0, runs: 0, handoffs: 0, bytes: 0 };

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

const removeRuns = async (runs: readonly Sized[], limit?: number) => {
  const removed = await pooled(runs, async (run) => ((await removeRun(run)) ? run.bytes : undefined), limit);
  const sizes = removed.flatMap((bytes) => bytes ?? []);

  return { ...NOTHING, runs: sizes.length, bytes: sizes.reduce((total, bytes) => total + bytes, 0) };
};

const removeHandoff = async ({ dir, bytes }: Sized): Promise<Removed> =>
  (await done(rm(dir, { recursive: true }))) === 1 ? { ...NOTHING, handoffs: 1, bytes } : NOTHING;

const changed = async ({ file, mtime }: Candidate) => {
  const stat = await lstat(file).catch(() => undefined);

  return stat !== undefined && stat.mtimeMs !== mtime;
};

const untouched = async (chain: readonly Candidate[], lives: Lives) => {
  const live = await lives();

  if (!live || chain.some((candidate) => isLive(live, candidate.id, candidate.file))) {
    return false;
  }

  const changes = await Promise.all(chain.map(changed));

  return !changes.includes(true);
};

const removeChain = async (chain: readonly Candidate[], lives: Lives): Promise<Removed[]> => {
  if (!(await untouched(chain, lives).catch(() => false))) {
    return [];
  }

  let stopped = false;

  const step = async (candidate: Candidate): Promise<Removed> => {
    if (stopped || (await done(unlink(candidate.file))) === 0) {
      stopped = true;
      return NOTHING;
    }

    const runs = await removeRuns(candidate.runs, 1);
    const handoff = candidate.handoff ? await removeHandoff(candidate.handoff) : NOTHING;

    return added([{ ...NOTHING, sessions: 1, bytes: candidate.bytes }, runs, handoff]);
  };

  return pooled(chain, step, 1);
};

export const clearEmpties = async (empties: readonly string[]) => {
  const cleared = await pooled(empties, (dir) => done(rmdir(dir)));

  return cleared.reduce((total, count) => total + count, 0);
};

export const apply = async (plan: Plan, lives: Lives): Promise<Removed> => {
  const chains = await pooled(plan.chains, (chain) => removeChain(chain, lives));
  const runs = await removeRuns(plan.orphans.runs);
  const handoffs = await pooled(plan.orphans.handoffs, removeHandoff);

  await pooled(plan.markers, (marker) => done(unlink(marker)));

  return added([...chains.flat(), runs, ...handoffs]);
};
