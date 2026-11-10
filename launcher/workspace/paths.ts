import { readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isWithin, lstatOrUndefined } from "../shared/index.ts";

const depthOf = (path: string) => path.split(sep).length;

export const byDepth = (first: string, second: string) =>
  depthOf(first) - depthOf(second) || first.localeCompare(second);

export const unique = (paths: string[]) => [...new Set(paths)];

export const dirsBetween = (root: string, path: string): string[] => {
  if (path === root || !isWithin(path, root)) {
    return [];
  }

  const parts = relative(root, path).split(sep);

  return parts.map((_, index) => join(root, ...parts.slice(0, index + 1)));
};

export const realOrPending = (path: string): Promise<string> =>
  realpath(path).catch(() => {
    const parent = dirname(path);

    return parent === path ? path : realOrPending(parent).then((real) => join(real, basename(path)));
  });

const MAX_LINKS = 40;

interface OnDisk {
  path: string;
  missing: boolean;
}

const walkedOnDisk = async (current: string, parts: string[], links: number): Promise<OnDisk> => {
  const [part, ...rest] = parts;

  if (part === undefined) {
    return { path: current, missing: false };
  }

  if (part === "" || part === ".") {
    return walkedOnDisk(current, rest, links);
  }

  if (part === "..") {
    return walkedOnDisk(dirname(current), rest, links);
  }

  const next = join(current, part);
  const info = await lstatOrUndefined(next);

  if (info === undefined || (info.isSymbolicLink() && links >= MAX_LINKS)) {
    return { path: resolve(next, ...rest), missing: true };
  }

  if (!info.isSymbolicLink()) {
    return walkedOnDisk(next, rest, links);
  }

  const target = await readlink(next);

  return walkedOnDisk(isAbsolute(target) ? sep : current, [...target.split(sep), ...rest], links + 1);
};

export const resolvedOnDisk = (base: string, text: string) =>
  walkedOnDisk(isAbsolute(text) ? sep : base, text.split(sep), 0);
