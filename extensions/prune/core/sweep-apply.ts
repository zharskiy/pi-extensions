import { lstat, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AGENTS_DIR } from "./agent-runs.ts";
import { rootState } from "./handoff-root.ts";
import { readLive } from "./live-markers.ts";
import { pathKey } from "./path-key.ts";
import { serial } from "./serial.ts";
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
  const removed = sum(await serial(runs, removeDir));

  if (removed > 0) {
    await rmdir(join(dir, AGENTS_DIR)).catch(ignore);
    await rmdir(dir).catch(ignore);
  }

  return removed;
};

const removeHandoff = async (dir: string, context: ApplyContext) =>
  (await rootState(context.handoffRoot)) === "safe" ? removeDir(dir) : 0;

const unlinkUnchanged = async ({ file, mtime }: Candidate) => {
  const stat = await lstat(file).catch(ignore);

  return stat?.mtimeMs === mtime ? done(unlink(file)) : 0;
};

const removeCandidate = async (candidate: Candidate, context: ApplyContext): Promise<Removed> => {
  const live = await readLive(context.agentDir, context.current, context.isAlive);

  if (!live || live.ids.has(candidate.id) || live.files.has(pathKey(candidate.file))) {
    return NOTHING;
  }

  if ((await unlinkUnchanged(candidate)) === 0) {
    return NOTHING;
  }

  return {
    sessions: 1,
    runs: candidate.stem ? await pruneStem(candidate.stem) : 0,
    handoffs: candidate.handoff ? await removeHandoff(candidate.handoff, context) : 0,
  };
};

export const apply = async (plan: Plan, context: ApplyContext): Promise<Removed> => {
  if (plan.aborted) {
    return NOTHING;
  }

  const sessions = await serial(plan.sessions, (candidate) => removeCandidate(candidate, context));
  const stems = await serial(plan.orphans.stems, pruneStem);
  const handoffs = await serial(plan.orphans.handoffs, (dir) => removeHandoff(dir, context));

  await serial(plan.markers, (marker) => done(unlink(marker)));

  return {
    sessions: sum(sessions.map((removed) => removed.sessions)),
    runs: sum([...sessions.map((removed) => removed.runs), ...stems]),
    handoffs: sum([...sessions.map((removed) => removed.handoffs), ...handoffs]),
  };
};
