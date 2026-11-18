import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { isWithin, realOrResolved } from "../shared/index.ts";

type Accept = (path: string, real: string) => Promise<boolean>;

export const isExecutable = async (path: string) => {
  const info = await stat(path).catch(() => undefined);

  return (
    info?.isFile() === true &&
    (await access(path, constants.X_OK).then(
      () => true,
      () => false,
    ))
  );
};

const withRealRoots = async (roots: string[]) => [
  ...roots,
  ...(await Promise.all(roots.map((root) => realOrResolved(root)))),
];

export const isInsideRoots = async (path: string, roots: string[]) => {
  if (roots.length === 0) {
    return false;
  }

  const [real, all] = await Promise.all([realOrResolved(path), withRealRoots(roots)]);

  return [path, real].some((candidate) => all.some((root) => isWithin(candidate, root)));
};

const isPathCandidate = async (path: string, excludedRoots: string[], accept: Accept) =>
  (await isExecutable(path)) &&
  !(await isInsideRoots(path, excludedRoots)) &&
  (await accept(path, await realOrResolved(path)));

export const findOnPath = async (
  env: Record<string, string | undefined>,
  name: string,
  excludedRoots: string[],
  accept: Accept = async () => true,
) => {
  const candidates = (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .map((dir) => join(dir, name));
  const found = await Promise.all(candidates.map((path) => isPathCandidate(path, excludedRoots, accept)));

  return candidates.find((_, index) => found[index]);
};
