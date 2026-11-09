import { lstat, rmdir } from "node:fs/promises";
import { sep } from "node:path";

const depthOf = (path: string) => path.split(sep).length;

const isDroppable = (error: unknown) =>
  ["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

const removeEmptyDir = async (path: string): Promise<string[]> => {
  const info = await lstat(path).catch(() => undefined);

  if (info === undefined || !info.isDirectory()) {
    return [];
  }

  return rmdir(path).then(
    () => [],
    (error: unknown) => (isDroppable(error) ? [] : [path]),
  );
};

export const removeCreatedDirs = (dirs: string[]) =>
  [...new Set(dirs)]
    .sort((first, second) => depthOf(second) - depthOf(first) || second.localeCompare(first))
    .reduce<Promise<string[]>>(
      async (kept, dir) => [...(await kept), ...(await removeEmptyDir(dir))],
      Promise.resolve([]),
    );
