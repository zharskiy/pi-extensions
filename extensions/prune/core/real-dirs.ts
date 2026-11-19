import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

const isRealDir = (dir: string) =>
  lstat(dir).then(
    (stat) => stat.isDirectory(),
    () => false,
  );

export const entriesIn = async (dir: string) =>
  (await isRealDir(dir)) ? await readdir(dir, { withFileTypes: true }).catch(() => []) : [];

export const subdirsIn = async (dir: string) =>
  (await entriesIn(dir)).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));

export const measure = async (dir: string, own?: Stats) => {
  const stat = own ?? (await lstat(dir));
  const names = await readdir(dir);
  const entries = await Promise.all(names.map((name) => lstat(join(dir, name))));

  return {
    touched: Math.max(stat.mtimeMs, ...entries.map((entry) => entry.mtimeMs)),
    bytes: entries.reduce((total, entry) => (entry.isFile() ? total + entry.size : total), 0),
  };
};
