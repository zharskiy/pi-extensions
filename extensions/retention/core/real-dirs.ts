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

export const lastTouched = async (dir: string) => {
  const names = await readdir(dir);
  const stats = await Promise.all([dir, ...names.map((name) => join(dir, name))].map((path) => lstat(path)));

  return Math.max(...stats.map((stat) => stat.mtimeMs));
};
