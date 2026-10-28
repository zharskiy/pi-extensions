import { statSync } from "node:fs";

export type LineageLink = { file: string; leafId?: string | null };

export type LineageWalk<T> = { links: T[]; truncated: boolean };

export type WalkOptions<T> = { key(link: T): string; max?: number };

export type LinkRead<T> =
  | { status: "read"; value: T }
  | { status: "missing" }
  | { status: "failed"; error: string };

const MAX_LINEAGE = 5;

export const linkKey = (link: LineageLink) => `${link.file}\n${link.leafId ?? ""}`;

export const walkLineage = <T>(
  start: T,
  previousOf: (link: T) => T | undefined,
  { key, max = MAX_LINEAGE }: WalkOptions<T>,
): LineageWalk<T> => {
  const step = (link: T, newer: T[], seen: Set<string>): LineageWalk<T> => {
    const chain = [link, ...newer];
    const previous = previousOf(link);

    if (previous === undefined) {
      return { links: chain, truncated: false };
    }

    if (seen.has(key(previous)) || chain.length >= max) {
      return { links: chain, truncated: true };
    }

    return step(previous, chain, new Set([...seen, key(previous)]));
  };

  return step(start, [], new Set([key(start)]));
};

type CachedRead<T> = { size: number; mtimeMs: number; value: T };

export const createFileReader = <T>(read: (file: string) => T) => {
  const cache = new Map<string, CachedRead<T>>();

  return (file: string): LinkRead<T> => {
    try {
      const stat = statSync(file, { throwIfNoEntry: false });

      if (!stat) {
        return { status: "missing" };
      }

      const cached = cache.get(file);

      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return { status: "read", value: cached.value };
      }

      const value = read(file);

      cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value });

      return { status: "read", value };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  };
};
