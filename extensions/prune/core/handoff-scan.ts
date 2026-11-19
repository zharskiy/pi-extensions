import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { LIMIT, pooled } from "./pool.ts";
import { measure } from "./real-dirs.ts";

export type Sized = { dir: string; bytes: number };

export type Aged = Sized & { touched: number };

export type HandoffScan = { owned: Map<string, Sized>; orphans: Aged[]; empties: string[] };

type Ids = { measured: ReadonlySet<string>; claimed: ReadonlySet<string>; live: ReadonlySet<string> };

type Ages = { latestCutoff: number; emptyBefore: number };

type Found = { owned?: Sized & { id: string }; orphan?: Aged; empty?: string };

const judge = async (root: string, name: string, ages: Ages, ids: Ids): Promise<Found> => {
  const dir = join(root, name);
  const stat = await lstat(dir).catch(() => undefined);

  if (!stat?.isDirectory()) {
    return {};
  }

  const empty = stat.mtimeMs < ages.emptyBefore && !ids.live.has(name) ? { empty: dir } : {};

  if (ids.measured.has(name)) {
    const { bytes } = await measure(dir, stat);

    return { ...empty, owned: { id: name, dir, bytes } };
  }

  if (ids.claimed.has(name) || stat.mtimeMs >= ages.latestCutoff) {
    return empty;
  }

  const { touched, bytes } = await measure(dir, stat);

  return touched < ages.latestCutoff ? { ...empty, orphan: { dir, touched, bytes } } : empty;
};

export const scanHandoffs = async (root: string, ages: Ages, ids: Ids): Promise<HandoffScan> => {
  const dir = await opendir(root).catch(() => undefined);

  if (!dir) {
    return { owned: new Map(), orphans: [], empties: [] };
  }

  const found = await pooled(dir, LIMIT, (entry) =>
    judge(root, entry.name, ages, ids).catch((): Found => ({})),
  );

  return {
    owned: new Map(
      found.flatMap(({ owned }) => (owned ? [[owned.id, { dir: owned.dir, bytes: owned.bytes }]] : [])),
    ),
    orphans: found.flatMap(({ orphan }) => orphan ?? []),
    empties: found.flatMap(({ empty }) => empty ?? []),
  };
};
