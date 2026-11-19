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

const DAY_MS = 86_400_000;

const SESSION_EXT = ".jsonl";

const PARENT_LEVELS = 5;

export type KeepReason = "fresh" | "live" | "parent";

export type ScanInput = {
  slugDirs: string[];
  agentDir: string;
  handoffRoot: string;
  current: Current;
  isAlive: (pid: number) => boolean;
};

export type PlanInput = ScanInput & { days: number; now: number };

type Session = { file: string; mtime: number; header?: SessionHeader; runs?: Run[] };

type Readable = Session & { header: SessionHeader };

type Listed = { files: string[]; stems: { dir: string; listed: boolean }[] };

export type Stem = { dir: string; runs: string[] };

type RunsIn = { dir: string; runs: Run[] };

export type Scan =
  | { aborted: string }
  | {
      live: Live;
      sessions: Session[];
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
  stem: Stem | undefined;
  handoff: string | undefined;
};

export type Plan = {
  cutoff: number;
  aborted?: string;
  sessions: Candidate[];
  orphans: { stems: Stem[]; handoffs: string[] };
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

  return "gone" in read ? {} : { session: { file, mtime: stat.mtimeMs, header: read.header } };
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

const reasons = (sessions: Readable[], cutoff: number, live: Live) => {
  const own = new Map<string, KeepReason>();

  sessions.forEach((session) => {
    if (session.mtime >= cutoff) {
      own.set(pathKey(session.file), "fresh");
      return;
    }

    if (live.ids.has(session.header.id) || live.files.has(pathKey(session.file))) {
      own.set(pathKey(session.file), "live");
    }
  });

  const byFile = new Map(sessions.map((session) => [pathKey(session.file), session]));

  const parentsOf = (files: string[]) =>
    files.flatMap((file) => {
      const parent = byFile.get(file)?.header.parentSession;

      return parent && byFile.has(pathKey(parent)) && !own.has(pathKey(parent)) ? [pathKey(parent)] : [];
    });

  Array.from({ length: PARENT_LEVELS }).reduce((level: string[]) => {
    const parents = parentsOf(level);

    parents.forEach((file) => {
      own.set(file, "parent");
    });

    return parents;
  }, Array.from(own.keys()));

  return own;
};

const sorted = (readable: Readable[], cutoff: number, live: Live) => {
  const kept = reasons(readable, cutoff, live);

  const keptIds = new Set([
    ...live.ids,
    ...readable.filter((session) => kept.has(pathKey(session.file))).map((session) => session.header.id),
  ]);

  return { kept, keptIds, candidates: readable.filter((session) => !kept.has(pathKey(session.file))) };
};

const isReadable = (session: Session): session is Readable => session.header !== undefined;

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
  sessions: [],
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

  const alwaysKept = new Set([
    ...live.ids,
    ...sessions.flatMap((session) => (session.mtime >= latestCutoff ? (session.header?.id ?? []) : [])),
  ]);

  const reading = sessions.filter(
    (session) =>
      session.header && session.mtime < latestCutoff && stemDirs.has(pathKey(stemOf(session.file))),
  );
  const found = await runsIn(reading.map((session) => stemOf(session.file)));
  const runsOf = new Map(reading.map((session, index) => [session.file, found[index].runs]));
  const scanned = sessions.map((session) => {
    const runs = runsOf.get(session.file);

    return runs ? { ...session, runs } : session;
  });

  const orphanStems = stems
    .filter(({ dir, listed }) => !listed && !live.files.has(pathKey(`${dir}${SESSION_EXT}`)))
    .map(({ dir }) => dir);

  const fallbackStems = (await subdirsIn(join(input.agentDir, "pi-subagents"))).filter(
    (dir) => !alwaysKept.has(basename(dir)),
  );

  const handoffState = await rootState(input.handoffRoot);
  const latest = sorted(sessions.filter(isReadable), latestCutoff, live);

  const measured = new Set(
    latest.candidates.map((session) => session.header.id).filter((id) => !latest.keptIds.has(id)),
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
    sessions: scanned,
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

  const { live, sessions } = scanned;
  const readable = sessions.filter(isReadable);
  const { kept, keptIds, candidates } = sorted(readable, cutoff, live);
  const fallbackStems = scanned.fallbackStems.filter(({ dir }) => !keptIds.has(basename(dir)));

  return {
    cutoff,
    sessions: candidates.map((session) => ({
      file: session.file,
      mtime: session.mtime,
      id: session.header.id,
      stem: session.runs ? pruned(stemOf(session.file), session.runs, cutoff)[0] : undefined,
      handoff: keptIds.has(session.header.id) ? undefined : scanned.owned.get(session.header.id)?.dir,
    })),
    orphans: {
      stems: [...scanned.orphanStems, ...fallbackStems].flatMap(({ dir, runs }) => pruned(dir, runs, cutoff)),
      handoffs: scanned.orphanHandoffs.filter(({ touched }) => touched < cutoff).map(({ dir }) => dir),
    },
    markers: live.dead,
    kept: readable.flatMap((session) => {
      const reason = kept.get(pathKey(session.file));

      return reason ? [{ file: session.file, reason }] : [];
    }),
    unreadable: sessions.filter((session) => session.header === undefined).map((session) => session.file),
    handoffsSkipped: scanned.handoffState === "unsafe",
  };
};

export const planAt = async (input: PlanInput) => {
  const cutoff = cutoffAt(input.now, input.days);

  return plan(await scan(input, cutoff), cutoff);
};

export const within = (fresh: Plan, confirmed: Plan): Plan => {
  const mtimes = new Map(confirmed.sessions.map((session) => [session.file, session.mtime]));

  const runs = new Set(
    [...confirmed.sessions.flatMap((session) => session.stem ?? []), ...confirmed.orphans.stems].flatMap(
      (stem) => stem.runs,
    ),
  );

  const handoffs = new Set([
    ...confirmed.sessions.flatMap((session) => session.handoff ?? []),
    ...confirmed.orphans.handoffs,
  ]);

  const confirmedRuns = (stem: Stem): Stem[] => {
    const kept = stem.runs.filter((run) => runs.has(run));

    return kept.length > 0 ? [{ dir: stem.dir, runs: kept }] : [];
  };

  return {
    ...fresh,
    sessions: fresh.sessions
      .filter((session) => mtimes.get(session.file) === session.mtime)
      .map((session) => ({
        ...session,
        stem: session.stem ? confirmedRuns(session.stem)[0] : undefined,
        handoff: session.handoff && handoffs.has(session.handoff) ? session.handoff : undefined,
      })),
    orphans: {
      stems: fresh.orphans.stems.flatMap(confirmedRuns),
      handoffs: fresh.orphans.handoffs.filter((dir) => handoffs.has(dir)),
    },
  };
};
