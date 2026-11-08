import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isWithin, readRegularFile } from "../shared/index.ts";

export const SCAN_BUDGET = 50_000;

const PACKAGES_PER_REPO = 256;

const GIT_FILE_PREFIX = "gitdir: ";

const SKIPPED_DIRS = new Set([".git", ".pi", "node_modules"]);

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

interface UnreadableDir {
  dir: string;
  code: string;
}

export interface WorkspaceScan {
  repos: string[];
  nodeProjects: string[];
  truncated: boolean;
  unreadable: UnreadableDir[];
}

export interface ScanOptions {
  nodeProjects?: boolean;
}

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

const hasLockfile = (level: Listed) => level.entries.some((entry) => LOCKFILES.has(entry.name));

const overlayable = (level: Listed) => {
  const modules = level.entries.find((entry) => entry.name === "node_modules");

  return modules === undefined || modules.isDirectory();
};

const isPackage = (level: Listed) =>
  !level.boundary && level.underLockfile && level.entries.some((entry) => entry.name === "package.json");

const repoOf = (level: Listed, root: string) => (level.boundary ? level.dir : (level.owners.at(-1) ?? root));

const isWalked = (entry: Dirent) => entry.isDirectory() && !SKIPPED_DIRS.has(entry.name);

const childrenOf = (level: Listed): Pending[] => {
  const owners = level.boundary ? [...level.owners, level.dir] : level.owners;
  const underLockfile = hasLockfile(level) || (!level.boundary && level.underLockfile);

  return level.entries
    .filter(isWalked)
    .map((entry) => ({ dir: join(level.dir, entry.name), owners, underLockfile }));
};

const withPackages = (levels: Listed[], root: string, walk: Walk) =>
  levels
    .filter((level) => overlayable(level) && !hasLockfile(level) && isPackage(level))
    .reduce(
      (state, level) => {
        const repo = repoOf(level, root);
        const count = state.packages[repo] ?? 0;

        return count >= PACKAGES_PER_REPO
          ? state
          : {
              nodeProjects: [...state.nodeProjects, level.dir],
              packages: { ...state.packages, [repo]: count + 1 },
            };
      },
      { nodeProjects: walk.nodeProjects, packages: walk.packages },
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
  const locked = levels.filter((level) => overlayable(level) && hasLockfile(level)).map((level) => level.dir);
  const packaged = withPackages(levels, root, { ...walk, nodeProjects: [...walk.nodeProjects, ...locked] });

  return walkLevel(levels.flatMap(childrenOf), root, findRepos, {
    repos: [...walk.repos, ...levels.filter((level) => level.registered).map((level) => level.dir)],
    nodeProjects: packaged.nodeProjects,
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
      nodeProjects: [],
      truncated: false,
      unreadable: [],
      budget: SCAN_BUDGET,
      packages: {},
    },
  );

  return {
    repos: walk.repos.sort(),
    nodeProjects: options.nodeProjects === false ? [] : walk.nodeProjects.sort(),
    truncated: walk.truncated,
    unreadable: walk.unreadable,
  };
};
