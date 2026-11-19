import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { LIMIT, pooled } from "./pool.ts";
import { measure } from "./real-dirs.ts";

export type Sized = { dir: string; bytes: number };

export type Aged = Sized & { touched: number };

export type HandoffScan = { owned: Map<string, Sized>; orphans: Aged[] };

type Ids = { measured: ReadonlySet<string>; claimed: ReadonlySet<string> };

type Found = { owned?: Sized & { id: string }; orphan?: Aged };

const judge = async (root: string, name: string, latestCutoff: number, ids: Ids): Promise<Found> => {
  if (ids.claimed.has(name) && !ids.measured.has(name)) {
    return {};
  }

  const dir = join(root, name);
  const stat = await lstat(dir).catch(() => undefined);

  if (!stat?.isDirectory()) {
    return {};
  }

  if (ids.measured.has(name)) {
    const { bytes } = await measure(dir, stat);

    return { owned: { id: name, dir, bytes } };
  }

  if (stat.mtimeMs >= latestCutoff) {
    return {};
  }

  const { touched, bytes } = await measure(dir, stat);

  return touched < latestCutoff ? { orphan: { dir, touched, bytes } } : {};
};

export const scanHandoffs = async (root: string, latestCutoff: number, ids: Ids): Promise<HandoffScan> => {
  const dir = await opendir(root).catch(() => undefined);

  if (!dir) {
    return { owned: new Map(), orphans: [] };
  }

  const found = await pooled(dir, LIMIT, (entry) =>
    judge(root, entry.name, latestCutoff, ids).catch((): Found => ({})),
  );

  return {
    owned: new Map(
      found.flatMap(({ owned }) => (owned ? [[owned.id, { dir: owned.dir, bytes: owned.bytes }]] : [])),
    ),
    orphans: found.flatMap(({ orphan }) => orphan ?? []),
  };
};
