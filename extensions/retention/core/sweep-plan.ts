import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readSessionHeader, type SessionHeader } from "../../../platform/pi-adapter/index.ts";
import { staleRuns } from "./agent-runs.ts";
import { rootState } from "./handoff-root.ts";
import { type Current, type Live, liveDir, readLive } from "./live-markers.ts";
import { pathKey } from "./path-key.ts";
import { entriesIn, lastTouched, subdirsIn } from "./real-dirs.ts";
import { serial } from "./serial.ts";

const DAY_MS = 86_400_000;

const SESSION_EXT = ".jsonl";

export type KeepReason = "fresh" | "live" | "parent";

export type PlanInput = {
  slugDirs: string[];
  agentDir: string;
  handoffRoot: string;
  current: Current;
  retentionDays: number;
  now: number;
  isAlive: (pid: number) => boolean;
};

type Session = { file: string; mtime: number; header?: SessionHeader };

type Readable = Session & { header: SessionHeader };

type Scanned = { sessions: Session[]; errors: string[]; stems: { dir: string; listed: boolean }[] };

export type Stem = { dir: string; runs: string[] };

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

const scanSlug = async (slug: string): Promise<Scanned> => {
  const entries = await entriesIn(slug);
  const names = new Set(entries.map((entry) => entry.name));
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(SESSION_EXT));
  const reads = await serial(files, (entry) => readSession(join(slug, entry.name)));

  const stems = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: join(slug, entry.name), listed: names.has(`${entry.name}${SESSION_EXT}`) }));

  return {
    sessions: reads.flatMap((read) => (read.session ? [read.session] : [])),
    errors: reads.flatMap((read) => (read.error ? [read.error] : [])),
    stems,
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

  const parents = new Set(
    sessions.flatMap((session) =>
      own.has(pathKey(session.file)) && session.header.parentSession
        ? [pathKey(session.header.parentSession)]
        : [],
    ),
  );

  sessions
    .filter((session) => !own.has(pathKey(session.file)) && parents.has(pathKey(session.file)))
    .forEach((session) => {
      own.set(pathKey(session.file), "parent");
    });

  return own;
};

const pruned = async (dir: string, cutoff: number): Promise<Stem | undefined> => {
  const runs = await staleRuns(dir, cutoff);

  return runs.length > 0 ? { dir, runs } : undefined;
};

const prunedAll = async (dirs: string[], cutoff: number) =>
  (await serial(dirs, (dir) => pruned(dir, cutoff))).filter((stem): stem is Stem => stem !== undefined);

const expiredHandoffs = async (dirs: string[], cutoff: number) => {
  const expired = await serial(dirs, async (dir) => {
    const touched = await lastTouched(dir).catch(() => Number.POSITIVE_INFINITY);

    return touched < cutoff ? [dir] : [];
  });

  return expired.flat();
};

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

export const plan = async (input: PlanInput): Promise<Plan> => {
  const cutoff = input.now - input.retentionDays * DAY_MS;
  const live = await readLive(input.agentDir, input.current, input.isAlive);

  if (!live) {
    return emptyPlan(cutoff, `${liveDir(input.agentDir)}: not a readable directory`);
  }

  const slugs = await serial(input.slugDirs, scanSlug);
  const error = slugs.flatMap((slug) => slug.errors)[0];

  if (error) {
    return emptyPlan(cutoff, error);
  }

  const sessions = slugs.flatMap((slug) => slug.sessions);
  const readable = sessions.filter((session): session is Readable => session.header !== undefined);
  const kept = reasons(readable, cutoff, live);
  const candidates = readable.filter((session) => !kept.has(pathKey(session.file)));
  const candidateIds = new Set(candidates.map((session) => session.header.id));

  const keptIds = new Set([
    ...live.ids,
    ...readable.filter((session) => kept.has(pathKey(session.file))).map((session) => session.header.id),
  ]);

  const stems = slugs.flatMap((slug) => slug.stems);
  const stemDirs = new Set(stems.map(({ dir }) => pathKey(dir)));

  const orphanStems = stems
    .filter(({ dir, listed }) => {
      const file = pathKey(`${dir}${SESSION_EXT}`);

      return !listed && !live.files.has(file);
    })
    .map(({ dir }) => dir);

  const fallbackStems = (await subdirsIn(join(input.agentDir, "pi-subagents"))).filter(
    (dir) => !keptIds.has(basename(dir)),
  );

  const handoffState = await rootState(input.handoffRoot);
  const handoffDirs = handoffState === "safe" ? await subdirsIn(input.handoffRoot) : [];
  const unclaimed = handoffDirs.filter((dir) => !keptIds.has(basename(dir)));
  const handoffOf = new Map(unclaimed.map((dir) => [basename(dir), dir]));

  const planned = await serial(candidates, async (session): Promise<Candidate> => {
    const stem = session.file.slice(0, -SESSION_EXT.length);

    return {
      file: session.file,
      mtime: session.mtime,
      id: session.header.id,
      stem: stemDirs.has(pathKey(stem)) ? await pruned(stem, cutoff) : undefined,
      handoff: handoffOf.get(session.header.id),
    };
  });

  const orphanHandoffs = unclaimed.filter((dir) => !candidateIds.has(basename(dir)));

  return {
    cutoff,
    sessions: planned,
    orphans: {
      stems: await prunedAll([...orphanStems, ...fallbackStems], cutoff),
      handoffs: await expiredHandoffs(orphanHandoffs, cutoff),
    },
    markers: live.dead,
    kept: readable.flatMap((session) => {
      const reason = kept.get(pathKey(session.file));

      return reason ? [{ file: session.file, reason }] : [];
    }),
    unreadable: sessions.filter((session) => session.header === undefined).map((session) => session.file),
    handoffsSkipped: handoffState === "unsafe",
  };
};
