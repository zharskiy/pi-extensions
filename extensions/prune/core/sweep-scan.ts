import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readSessionHeader, type SessionHeader } from "../../../platform/pi-adapter/index.ts";
import { SESSION_EXT, scanRuns } from "./agent-runs.ts";
import { rootState, scanHandoffs } from "./handoff-scan.ts";
import { isLive, type Live, liveDir } from "./live-markers.ts";
import { pooled } from "./pool.ts";
import { entriesIn, subdirsIn } from "./real-dirs.ts";
import { chainsOf } from "./session-chains.ts";
import { keptIdsOf, removableAt, type Scan } from "./sweep-plan.ts";

const DAY_MS = 86_400_000;

export type Sources = { agentDir: string; handoffRoot: string; live: () => Promise<Live | undefined> };

type Session = { file: string; mtime: number; bytes: number; header?: SessionHeader };

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

const listSlug = async (slug: string) => {
  const entries = (await entriesIn(slug)) ?? [];
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

const memberOf = (session: Session, live: Live) => ({
  file: session.file,
  mtime: session.mtime,
  id: session.header?.id,
  bytes: session.bytes,
  parent: session.header?.parentSession,
  live: session.header === undefined || isLive(live, session.header.id, session.file),
});

export const scan = async (sources: Sources, latestCutoff: number, now: number): Promise<string | Scan> => {
  const live = await sources.live();

  if (!live) {
    return `${liveDir(sources.agentDir)}: not a readable directory`;
  }

  const slugs = await pooled(await subdirsIn(join(sources.agentDir, "sessions")), listSlug);
  const reads = await pooled(
    slugs.flatMap((slug) => slug.files),
    readSession,
  );
  const error = reads.flatMap((read) => read.error ?? [])[0];

  if (error) {
    return error;
  }

  const sessions = reads.flatMap((read) => read.session ?? []);
  const ids = new Set(sessions.flatMap((session) => session.header?.id ?? []));
  const chains = chainsOf(sessions.map((session) => memberOf(session, live)));
  const removable = chains.filter((chain) => removableAt(chain, latestCutoff));
  const alwaysKept = keptIdsOf(chains, latestCutoff, live);

  const handoffState = await rootState(sources.handoffRoot);
  const measured = new Set(
    removable.flatMap((chain) => chain.members.flatMap(({ id }) => (id && !alwaysKept.has(id) ? [id] : []))),
  );

  const handoffs =
    handoffState === "safe"
      ? await scanHandoffs(
          sources.handoffRoot,
          { latestCutoff, emptyBefore: now - DAY_MS },
          { measured, claimed: new Set([...ids, ...live.ids]), live: live.ids },
        )
      : { owned: new Map(), orphans: [], empties: [] };

  const runs = await scanRuns(sources.agentDir, {
    files: removable.flatMap((chain) => chain.members.map(({ file }) => file)),
    stems: slugs.flatMap((slug) => slug.stems),
    live: live.files,
    kept: alwaysKept,
  });

  return {
    live,
    chains,
    ...runs,
    latestCutoff,
    skipped: handoffState === "unsafe" ? sources.handoffRoot : undefined,
    owned: handoffs.owned,
    orphanHandoffs: handoffs.orphans,
    empties: handoffs.empties,
  };
};
