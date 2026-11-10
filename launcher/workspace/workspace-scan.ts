import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isWithin, readRegularFile } from "../shared/index.ts";
import { gitFileTarget, hasGitDirShape, isGitName } from "./git/layout.ts";
import { isNodeLockfile, NODE_OVERLAY, overlaysMarkedBy } from "./overlay-markers.ts";
import { walkLevels } from "./walk.ts";

const SCAN_BUDGET = 50_000;

const PACKAGES_PER_REPO = 256;

const SKIPPED_DIRS = new Set([".pi", "node_modules"]);

interface UnreadableDir {
  dir: string;
  code: string;
}

export interface WorkspaceScan {
  repos: string[];
  bare: string[];
  overlays: string[];
  variants: string[];
  truncated: boolean;
  unreadable: UnreadableDir[];
}

export interface ScanOptions {
  overlays?: boolean;
  budget?: number;
  skipOverlays?: boolean;
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
  bare: boolean;
  registered: boolean;
}

interface Walk {
  repos: string[];
  bare: string[];
  overlays: string[];
  variants: string[];
  unreadable: UnreadableDir[];
  packages: Record<string, number>;
}

const realOrLexical = (path: string) => realpath(path).catch(() => path);

const isSubmodule = async (dir: string, name: string, owners: string[]) => {
  const text = await readRegularFile(join(dir, name)).then(
    (file) => file.data.toString("utf8"),
    () => "",
  );
  const pointer = gitFileTarget(dir, text);

  if (pointer === undefined) {
    return false;
  }

  const target = await realOrLexical(pointer);

  return owners.some((owner) => isWithin(target, join(owner, ".git", "modules")));
};

const isRegistered = async (dotGit: Dirent | undefined, pending: Pending, findRepos: boolean) => {
  if (!findRepos || dotGit === undefined) {
    return false;
  }

  return !dotGit.isFile() || !(await isSubmodule(pending.dir, dotGit.name, pending.owners));
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
  const dotGit =
    entries.find((entry) => entry.name === ".git") ?? entries.find((entry) => isGitName(entry.name));

  return {
    ...pending,
    entries,
    ...(unreadable === undefined ? {} : { unreadable }),
    boundary: dotGit !== undefined,
    bare: dotGit === undefined && hasGitDirShape(entries.map((entry) => entry.name)),
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

const isWalked = (entry: Dirent) =>
  entry.isDirectory() && !SKIPPED_DIRS.has(entry.name) && !isGitName(entry.name);

const childrenOf =
  (skipOverlays: boolean) =>
  (level: Listed): Pending[] => {
    if (level.bare) {
      return [];
    }

    const owners = level.boundary ? [...level.owners, level.dir] : level.owners;
    const underLockfile = hasNodeLockfile(level) || (!level.boundary && level.underLockfile);
    const skipped = skipOverlays ? overlaysMarkedBy(level.entries.map((entry) => entry.name)) : [];

    return level.entries
      .filter((entry) => isWalked(entry) && !skipped.includes(entry.name))
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

const folded =
  (root: string) =>
  (walk: Walk, levels: Listed[]): Walk => {
    const packaged = withPackages(levels, root, {
      ...walk,
      overlays: [...walk.overlays, ...levels.flatMap(markedOverlays)],
    });

    return {
      repos: [...walk.repos, ...levels.filter((level) => level.registered).map((level) => level.dir)],
      variants: [
        ...walk.variants,
        ...levels.flatMap((level) =>
          level.entries
            .filter((entry) => entry.name !== ".git" && isGitName(entry.name))
            .map((entry) => join(level.dir, entry.name)),
        ),
      ],
      bare: [...walk.bare, ...levels.filter((level) => level.bare).map((level) => level.dir)],
      overlays: packaged.overlays,
      packages: packaged.packages,
      unreadable: [
        ...walk.unreadable,
        ...levels.flatMap((level) =>
          level.unreadable === undefined ? [] : [{ dir: level.dir, code: level.unreadable }],
        ),
      ],
    };
  };

export const scanWorkspace = async (
  root: string,
  mode: "workspace" | "git",
  options: ScanOptions = {},
): Promise<WorkspaceScan> => {
  const findRepos = mode === "workspace";
  const skipOverlays = options.skipOverlays === true && options.overlays !== false;
  const { state, complete } = await walkLevels(
    [{ dir: root, owners: [], underLockfile: false }],
    scanBudgetOf(options.budget),
    { repos: [], bare: [], overlays: [], variants: [], unreadable: [], packages: {} } as Walk,
    {
      list: (pending: Pending) => listed(pending, findRepos),
      children: childrenOf(skipOverlays),
      fold: folded(root),
    },
  );

  return {
    repos: state.repos.sort(),
    bare: findRepos ? state.bare.sort() : [],
    variants: state.variants.sort(),
    overlays: options.overlays === false ? [] : state.overlays.sort(),
    truncated: !complete,
    unreadable: state.unreadable,
  };
};
