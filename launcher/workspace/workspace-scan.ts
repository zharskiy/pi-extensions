import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isWithin, readRegularFile } from "../shared/index.ts";
import { isNodeLockfile, NODE_OVERLAY, overlaysMarkedBy } from "./overlay-markers.ts";

const SCAN_BUDGET = 50_000;

const PACKAGES_PER_REPO = 256;

const GIT_FILE_PREFIX = "gitdir: ";

const SKIPPED_DIRS = new Set([".git", ".pi", "node_modules"]);

interface UnreadableDir {
  dir: string;
  code: string;
}

export interface WorkspaceScan {
  repos: string[];
  overlays: string[];
  truncated: boolean;
  unreadable: UnreadableDir[];
}

export interface ScanOptions {
  overlays?: boolean;
  budget?: number;
}

export const scanBudgetOf = (budget = SCAN_BUDGET) => budget;

interface Pending {
  dir: string;
  owners: string[];
  underLockfile: boolean;
}

interface Listed extends Pending {
  entries: Dirent[];
  unreadable?: string;
  boundary: boolean;
  registered: boolean;
}

interface Walk extends WorkspaceScan {
  budget: number;
  packages: Record<string, number>;
}

const realOrLexical = (path: string) => realpath(path).catch(() => path);

const isSubmodule = async (dir: string, owners: string[]) => {
  const text = await readRegularFile(join(dir, ".git")).then(
    (file) => file.data.toString("utf8"),
    () => "",
  );
  const [line = ""] = text.split("\n");

  if (!line.startsWith(GIT_FILE_PREFIX)) {
    return false;
  }

  const target = await realOrLexical(resolve(dir, line.slice(GIT_FILE_PREFIX.length).trim()));

  return owners.some((owner) => isWithin(target, join(owner, ".git", "modules")));
};

const isRegistered = async (dotGit: Dirent | undefined, pending: Pending, findRepos: boolean) => {
  if (!findRepos || dotGit === undefined) {
    return false;
  }

  return !dotGit.isFile() || !(await isSubmodule(pending.dir, pending.owners));
};

const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

const readEntries = (dir: string) =>
  readdir(dir, { withFileTypes: true }).then(
    (entries): { entries: Dirent[]; unreadable?: string } => ({ entries }),
    (error: NodeJS.ErrnoException) => ({
      entries: [] as Dirent[],
      unreadable: ABSENT.has(error.code ?? "") ? undefined : (error.code ?? "EIO"),
    }),
  );

const listed = async (pending: Pending, findRepos: boolean): Promise<Listed> => {
  const { entries, unreadable } = await readEntries(pending.dir);
  const dotGit = entries.find((entry) => entry.name === ".git");

  return {
    ...pending,
    entries,
    ...(unreadable === undefined ? {} : { unreadable }),
    boundary: dotGit !== undefined,
    registered: await isRegistered(dotGit, pending, findRepos),
  };
};

const hasNodeLockfile = (level: Listed) => level.entries.some((entry) => isNodeLockfile(entry.name));

const overlayable = (level: Listed, target: string) => {
  const existing = level.entries.find((entry) => entry.name === target);

  return existing === undefined || existing.isDirectory();
};

const markedOverlays = (level: Listed) =>
  overlaysMarkedBy(level.entries.map((entry) => entry.name))
    .filter((target) => overlayable(level, target))
    .map((target) => join(level.dir, target));

const isPackage = (level: Listed) =>
  !level.boundary &&
  level.underLockfile &&
  !hasNodeLockfile(level) &&
  overlayable(level, NODE_OVERLAY) &&
  level.entries.some((entry) => entry.name === "package.json");

const repoOf = (level: Listed, root: string) => (level.boundary ? level.dir : (level.owners.at(-1) ?? root));

const isWalked = (entry: Dirent) => entry.isDirectory() && !SKIPPED_DIRS.has(entry.name);

const childrenOf = (level: Listed): Pending[] => {
  const owners = level.boundary ? [...level.owners, level.dir] : level.owners;
  const underLockfile = hasNodeLockfile(level) || (!level.boundary && level.underLockfile);

  return level.entries
    .filter(isWalked)
    .map((entry) => ({ dir: join(level.dir, entry.name), owners, underLockfile }));
};

const withPackages = (levels: Listed[], root: string, walk: Walk) =>
  levels.filter(isPackage).reduce(
    (state, level) => {
      const repo = repoOf(level, root);
      const count = state.packages[repo] ?? 0;

      return count >= PACKAGES_PER_REPO
        ? state
        : {
            overlays: [...state.overlays, join(level.dir, NODE_OVERLAY)],
            packages: { ...state.packages, [repo]: count + 1 },
          };
    },
    { overlays: walk.overlays, packages: walk.packages },
  );

const walkLevel = async (dirs: Pending[], root: string, findRepos: boolean, walk: Walk): Promise<Walk> => {
  if (dirs.length === 0) {
    return walk;
  }

  if (walk.budget <= 0) {
    return { ...walk, truncated: true };
  }

  const taken = dirs.slice(0, walk.budget);
  const levels = await Promise.all(taken.map((pending) => listed(pending, findRepos)));
  const marked = levels.flatMap(markedOverlays);
  const packaged = withPackages(levels, root, { ...walk, overlays: [...walk.overlays, ...marked] });

  return walkLevel(levels.flatMap(childrenOf), root, findRepos, {
    repos: [...walk.repos, ...levels.filter((level) => level.registered).map((level) => level.dir)],
    overlays: packaged.overlays,
    packages: packaged.packages,
    truncated: walk.truncated || taken.length < dirs.length,
    unreadable: [
      ...walk.unreadable,
      ...levels.flatMap((level) =>
        level.unreadable === undefined ? [] : [{ dir: level.dir, code: level.unreadable }],
      ),
    ],
    budget: walk.budget - taken.length,
  });
};

export const scanWorkspace = async (
  root: string,
  mode: "workspace" | "git",
  options: ScanOptions = {},
): Promise<WorkspaceScan> => {
  const walk = await walkLevel(
    [{ dir: root, owners: [], underLockfile: false }],
    root,
    mode === "workspace",
    {
      repos: [],
      overlays: [],
      truncated: false,
      unreadable: [],
      budget: scanBudgetOf(options.budget),
      packages: {},
    },
  );

  return {
    repos: walk.repos.sort(),
    overlays: options.overlays === false ? [] : walk.overlays.sort(),
    truncated: walk.truncated,
    unreadable: walk.unreadable,
  };
};
