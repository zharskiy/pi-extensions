import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export type Sized = { dir: string; bytes: number };

export type Aged = Sized & { touched: number };

export const entriesIn = async (dir: string) => {
  const stat = await lstat(dir).catch((error: NodeJS.ErrnoException) => error.code);

  if (stat === "ENOENT") {
    return [];
  }

  if (typeof stat !== "object" || !stat.isDirectory()) {
    return undefined;
  }

  return readdir(dir, { withFileTypes: true }).catch(() => undefined);
};

export const subdirsIn = async (dir: string) =>
  ((await entriesIn(dir)) ?? []).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));

export const measure = async (dir: string, own?: Stats) => {
  const stat = own ?? (await lstat(dir));
  const names = await readdir(dir);
  const entries = await Promise.all(names.map((name) => lstat(join(dir, name))));

  return {
    touched: Math.max(stat.mtimeMs, ...entries.map((entry) => entry.mtimeMs)),
    bytes: entries.reduce((total, entry) => (entry.isFile() ? total + entry.size : total), 0),
  };
};
