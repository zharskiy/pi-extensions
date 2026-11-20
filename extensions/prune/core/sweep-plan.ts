import { type Run, staleRuns } from "./agent-runs.ts";
import type { Live } from "./live-markers.ts";
import type { Aged, Sized } from "./real-dirs.ts";
import type { Chain } from "./session-chains.ts";

const DAY_MS = 86_400_000;

export type Scan = {
  live: Live;
  chains: Chain[];
  runs: Map<string, Run[]>;
  orphanRuns: Run[][];
  fallbackRuns: Map<string, Run[]>;
  latestCutoff: number;
  skipped: string | undefined;
  owned: Map<string, Sized>;
  orphanHandoffs: Aged[];
  empties: string[];
};

export type Candidate = {
  file: string;
  mtime: number;
  id: string;
  bytes: number;
  runs: Sized[];
  handoff?: Sized;
};

export type Plan = {
  chains: Candidate[][];
  orphans: { runs: Sized[]; handoffs: Sized[] };
  markers: string[];
  skipped: string | undefined;
};

export type Removed = { sessions: number; runs: number; handoffs: number; bytes: number };

export const itemsOf = (removed: Removed) => removed.sessions + removed.runs + removed.handoffs;

export const cutoffAt = (now: number, days: number) => now - days * DAY_MS;

export const removableAt = (chain: Chain, cutoff: number) => !chain.live && chain.newest < cutoff;

export const keptIdsOf = (chains: readonly Chain[], cutoff: number, live: Live) =>
  new Set([
    ...live.ids,
    ...chains
      .filter((chain) => !removableAt(chain, cutoff))
      .flatMap((chain) => chain.members.flatMap(({ id }) => id ?? [])),
  ]);

export const plan = (scanned: Scan, cutoff: number): Plan => {
  if (cutoff > scanned.latestCutoff) {
    throw new Error("plan: cutoff after the scan's latest cutoff");
  }

  const keptIds = keptIdsOf(scanned.chains, cutoff, scanned.live);
  const fallbacks = [...scanned.fallbackRuns].flatMap(([id, runs]) => (keptIds.has(id) ? [] : [runs]));

  return {
    chains: scanned.chains
      .filter((chain) => removableAt(chain, cutoff))
      .map((chain) =>
        chain.members.map(({ file, mtime, id = "", bytes }) => ({
          file,
          mtime,
          id,
          bytes,
          runs: staleRuns(scanned.runs.get(file) ?? [], cutoff),
          handoff: keptIds.has(id) ? undefined : scanned.owned.get(id),
        })),
      ),
    orphans: {
      runs: [...scanned.orphanRuns, ...fallbacks].flatMap((runs) => staleRuns(runs, cutoff)),
      handoffs: scanned.orphanHandoffs
        .filter(({ touched }) => touched < cutoff)
        .map(({ dir, bytes }) => ({ dir, bytes })),
    },
    markers: scanned.live.dead,
    skipped: scanned.skipped,
  };
};

const contents = (plan: Plan) => {
  const sessions = plan.chains.flat();
  const handoffs = [...sessions.flatMap(({ handoff }) => handoff ?? []), ...plan.orphans.handoffs];

  return {
    sessions,
    runs: [...sessions.flatMap(({ runs }) => runs), ...plan.orphans.runs],
    handoffs: [...new Map(handoffs.map((handoff) => [handoff.dir, handoff])).values()],
  };
};

const sizeOf = (items: readonly { bytes: number }[]) => items.reduce((total, item) => total + item.bytes, 0);

export const totals = (plan: Plan): Removed => {
  const { sessions, runs, handoffs } = contents(plan);

  return {
    sessions: sessions.length,
    runs: runs.length,
    handoffs: handoffs.length,
    bytes: sizeOf(sessions) + sizeOf(runs) + sizeOf(handoffs),
  };
};

export const within = (fresh: Plan, confirmed: Plan): Plan => {
  const kept = contents(confirmed);
  const mtimes = new Map(kept.sessions.map((session) => [session.file, session.mtime]));
  const runs = new Set(kept.runs.map(({ dir }) => dir));
  const handoffs = new Set(kept.handoffs.map(({ dir }) => dir));
  const confirmedRuns = (found: readonly Sized[]) => found.filter(({ dir }) => runs.has(dir));

  return {
    ...fresh,
    chains: fresh.chains
      .filter((chain) => chain.every((session) => mtimes.get(session.file) === session.mtime))
      .map((chain) =>
        chain.map((session) => ({
          ...session,
          runs: confirmedRuns(session.runs),
          handoff: session.handoff && handoffs.has(session.handoff.dir) ? session.handoff : undefined,
        })),
      ),
    orphans: {
      runs: confirmedRuns(fresh.orphans.runs),
      handoffs: fresh.orphans.handoffs.filter(({ dir }) => handoffs.has(dir)),
    },
  };
};
