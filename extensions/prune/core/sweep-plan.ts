import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readSessionHeader, type SessionHeader } from "../../../platform/pi-adapter/index.ts";
import { type Run, readRuns, staleRuns } from "./agent-runs.ts";
import { type RootState, rootState } from "./handoff-root.ts";
import { type Aged, type Sized, scanHandoffs } from "./handoff-scan.ts";
import { type Current, type Live, liveDir, readLive } from "./live-markers.ts";
import { pathKey } from "./path-key.ts";
import { LIMIT, pooled } from "./pool.ts";
import { entriesIn, subdirsIn } from "./real-dirs.ts";
import { type Chain, chainsOf, type Member } from "./session-chains.ts";

const DAY_MS = 86_400_000;

const SESSION_EXT = ".jsonl";

export type KeepReason = "fresh" | "live" | "chain";

export type ScanInput = {
  slugDirs: string[];
  agentDir: string;
  handoffRoot: string;
  current: Current;
  isAlive: (pid: number) => boolean;
};

export type PlanInput = ScanInput & { days: number; now: number };

type Session = { file: string; mtime: number; bytes: number; header?: SessionHeader };

type Linked = Member & { runs?: Run[] };

type Linkage = Chain<Linked>;

type Listed = { files: string[]; stems: { dir: string; listed: boolean }[] };

export type Stem = { dir: string; runs: Sized[] };

type RunsIn = { dir: string; runs: Run[] };

export type Scan =
  | { aborted: string }
  | {
      live: Live;
      chains: Linkage[];
      orphanStems: RunsIn[];
      fallbackStems: RunsIn[];
      latestCutoff: number;
      handoffState: RootState;
      owned: Map<string, Sized>;
      orphanHandoffs: Aged[];
    };

export type Candidate = {
  file: string;
  mtime: number;
  id: string;
  bytes: number;
  stem: Stem | undefined;
  handoff: Sized | undefined;
};

export type Removed = { sessions: number; runs: number; handoffs: number; bytes: number };

export type Plan = {
  cutoff: number;
  aborted?: string;
  chains: Candidate[][];
  orphans: { stems: Stem[]; handoffs: Sized[] };
  markers: string[];
  kept: { file: string; reason: KeepReason }[];
  unreadable: string[];
  handoffsSkipped: boolean;
};

const readSession = async (file: string): Promise<{ session?: Session; error?: string }> => {
  const stat = await lstat(file).catch(() => undefined);

  if (!stat) {
    return {};
  }

  const read = await readSessionHeader(file);

  if ("error" in read) {
    return { error: `${file}: ${read.error}` };
  }

  return "gone" in read
    ? {}
    : { session: { file, mtime: stat.mtimeMs, bytes: stat.size, header: read.header } };
};

const listSlug = async (slug: string): Promise<Listed> => {
  const entries = await entriesIn(slug);
  const names = new Set(entries.map((entry) => entry.name));

  return {
    files: entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(SESSION_EXT))
      .map((entry) => join(slug, entry.name)),
    stems: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ dir: join(slug, entry.name), listed: names.has(`${entry.name}${SESSION_EXT}`) })),
  };
};

const memberOf = (session: Session, live: Live): Linked => ({
  file: session.file,
  mtime: session.mtime,
  id: session.header?.id,
  bytes: session.bytes,
  parent: session.header?.parentSession,
  live:
    (session.header !== undefined && live.ids.has(session.header.id)) ||
    live.files.has(pathKey(session.file)),
  pinned: session.header === undefined,
});

const removableAt = (chain: Chain, cutoff: number) => !chain.live && chain.newest < cutoff;

const keptIdsOf = (chains: readonly Linkage[], cutoff: number, live: Live) =>
  new Set([
    ...live.ids,
    ...chains
      .filter((chain) => !removableAt(chain, cutoff))
      .flatMap((chain) => chain.members.flatMap(({ id }) => id ?? [])),
  ]);

const reasonOf = (member: Member, cutoff: number): KeepReason => {
  if (member.mtime >= cutoff) {
    return "fresh";
  }

  return member.live ? "live" : "chain";
};

const pruned = (dir: string, found: readonly Run[], cutoff: number): Stem[] => {
  const runs = staleRuns(found, cutoff);

  return runs.length > 0 ? [{ dir, runs }] : [];
};

const runsIn = async (dirs: readonly string[]): Promise<RunsIn[]> => {
  const runs = await readRuns(dirs);

  return dirs.map((dir, index) => ({ dir, runs: runs[index] }));
};

const stemOf = (file: string) => file.slice(0, -SESSION_EXT.length);

const emptyPlan = (cutoff: number, aborted: string): Plan => ({
  cutoff,
  aborted,
  chains: [],
  orphans: { stems: [], handoffs: [] },
  markers: [],
  kept: [],
  unreadable: [],
  handoffsSkipped: false,
});

export const cutoffAt = (now: number, days: number) => now - days * DAY_MS;

export const scan = async (input: ScanInput, latestCutoff: number): Promise<Scan> => {
  const live = await readLive(input.agentDir, input.current, input.isAlive);

  if (!live) {
    return { aborted: `${liveDir(input.agentDir)}: not a readable directory` };
  }

  const slugs = await pooled(input.slugDirs, LIMIT, listSlug);
  const reads = await pooled(
    slugs.flatMap((slug) => slug.files),
    LIMIT,
    readSession,
  );
  const error = reads.flatMap((read) => read.error ?? [])[0];

  if (error) {
    return { aborted: error };
  }

  const sessions = reads.flatMap((read) => read.session ?? []);
  const ids = new Set(sessions.flatMap((session) => session.header?.id ?? []));
  const stems = slugs.flatMap((slug) => slug.stems);
  const stemDirs = new Set(stems.map(({ dir }) => pathKey(dir)));
  const chains = chainsOf(sessions.map((session) => memberOf(session, live)));
  const removable = chains.filter((chain) => removableAt(chain, latestCutoff));
  const alwaysKept = keptIdsOf(chains, latestCutoff, live);

  const reading = removable
    .flatMap((chain) => chain.members)
    .filter((member) => stemDirs.has(pathKey(stemOf(member.file))));

  const found = await runsIn(reading.map((member) => stemOf(member.file)));

  reading.forEach((member, index) => {
    member.runs = found[index].runs;
  });

  const orphanStems = stems
    .filter(({ dir, listed }) => !listed && !live.files.has(pathKey(`${dir}${SESSION_EXT}`)))
    .map(({ dir }) => dir);

  const fallbackStems = (await subdirsIn(join(input.agentDir, "pi-subagents"))).filter(
    (dir) => !alwaysKept.has(basename(dir)),
  );

  const handoffState = await rootState(input.handoffRoot);
  const measured = new Set(
    removable.flatMap((chain) => chain.members.flatMap(({ id }) => (id && !alwaysKept.has(id) ? [id] : []))),
  );

  const handoffs =
    handoffState === "safe"
      ? await scanHandoffs(input.handoffRoot, latestCutoff, {
          measured,
          claimed: new Set([...ids, ...live.ids]),
        })
      : { owned: new Map<string, Sized>(), orphans: [] };

  return {
    live,
    chains,
    orphanStems: await runsIn(orphanStems),
    fallbackStems: await runsIn(fallbackStems),
    latestCutoff,
    handoffState,
    owned: handoffs.owned,
    orphanHandoffs: handoffs.orphans,
  };
};

export const plan = (scanned: Scan, cutoff: number): Plan => {
  if ("aborted" in scanned) {
    return emptyPlan(cutoff, scanned.aborted);
  }

  if (cutoff > scanned.latestCutoff) {
    throw new Error("plan: cutoff after the scan's latest cutoff");
  }

  const { live, chains } = scanned;
  const keptIds = keptIdsOf(chains, cutoff, live);
  const kept = chains.filter((chain) => !removableAt(chain, cutoff)).flatMap((chain) => chain.members);
  const fallbackStems = scanned.fallbackStems.filter(({ dir }) => !keptIds.has(basename(dir)));

  return {
    cutoff,
    chains: chains
      .filter((chain) => removableAt(chain, cutoff))
      .map((chain) =>
        chain.members.map((member) => {
          const id = member.id ?? "";

          return {
            file: member.file,
            mtime: member.mtime,
            id,
            bytes: member.bytes,
            stem: member.runs ? pruned(stemOf(member.file), member.runs, cutoff)[0] : undefined,
            handoff: keptIds.has(id) ? undefined : scanned.owned.get(id),
          };
        }),
      ),
    orphans: {
      stems: [...scanned.orphanStems, ...fallbackStems].flatMap(({ dir, runs }) => pruned(dir, runs, cutoff)),
      handoffs: scanned.orphanHandoffs
        .filter(({ touched }) => touched < cutoff)
        .map(({ dir, bytes }) => ({ dir, bytes })),
    },
    markers: live.dead,
    kept: kept.flatMap((member) =>
      member.pinned ? [] : [{ file: member.file, reason: reasonOf(member, cutoff) }],
    ),
    unreadable: kept.flatMap((member) => (member.pinned ? [member.file] : [])),
    handoffsSkipped: scanned.handoffState === "unsafe",
  };
};

const sizeOf = (items: readonly Sized[]) => items.reduce((total, item) => total + item.bytes, 0);

export const totals = (plan: Plan): Removed => {
  const sessions = plan.chains.flat();
  const runs = [...sessions.flatMap((session) => session.stem ?? []), ...plan.orphans.stems].flatMap(
    (stem) => stem.runs,
  );
  const handoffs = [
    ...new Map(
      [...sessions.flatMap((session) => session.handoff ?? []), ...plan.orphans.handoffs].map((handoff) => [
        handoff.dir,
        handoff,
      ]),
    ).values(),
  ];

  return {
    sessions: sessions.length,
    runs: runs.length,
    handoffs: handoffs.length,
    bytes: sessions.reduce((total, session) => total + session.bytes, 0) + sizeOf(runs) + sizeOf(handoffs),
  };
};

export const planAt = async (input: PlanInput) => {
  const cutoff = cutoffAt(input.now, input.days);

  return plan(await scan(input, cutoff), cutoff);
};

export const within = (fresh: Plan, confirmed: Plan): Plan => {
  const confirmedSessions = confirmed.chains.flat();
  const mtimes = new Map(confirmedSessions.map((session) => [session.file, session.mtime]));

  const runs = new Set(
    [...confirmedSessions.flatMap((session) => session.stem ?? []), ...confirmed.orphans.stems].flatMap(
      (stem) => stem.runs.map(({ dir }) => dir),
    ),
  );

  const handoffs = new Set(
    [...confirmedSessions.flatMap((session) => session.handoff ?? []), ...confirmed.orphans.handoffs].map(
      ({ dir }) => dir,
    ),
  );

  const confirmedRuns = (stem: Stem): Stem[] => {
    const kept = stem.runs.filter((run) => runs.has(run.dir));

    return kept.length > 0 ? [{ dir: stem.dir, runs: kept }] : [];
  };

  return {
    ...fresh,
    chains: fresh.chains
      .filter((chain) => chain.every((session) => mtimes.get(session.file) === session.mtime))
      .map((chain) =>
        chain.map((session) => ({
          ...session,
          stem: session.stem ? confirmedRuns(session.stem)[0] : undefined,
          handoff: session.handoff && handoffs.has(session.handoff.dir) ? session.handoff : undefined,
        })),
      ),
    orphans: {
      stems: fresh.orphans.stems.flatMap(confirmedRuns),
      handoffs: fresh.orphans.handoffs.filter(({ dir }) => handoffs.has(dir)),
    },
  };
};
