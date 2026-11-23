import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isNodeLockfile, NODE_OVERLAY, overlaysMarkedBy } from "./overlay-markers.ts";
import { walkLevels } from "./walk.ts";

const SCAN_BUDGET = 50_000;

const PACKAGES_PER_REPO = 256;

const SKIPPED_DIRS = new Set([".pi", "node_modules"]);

export interface OverlayScan {
  overlays: string[];
  truncated: boolean;
}

interface Pending {
  dir: string;
  owners: string[];
  underLockfile: boolean;
}

interface Listed extends Pending {
  entries: Dirent[];
  boundary: boolean;
}

interface Walk {
  overlays: string[];
  packages: Record<string, number>;
}

const isGitName = (name: string) => name.toLowerCase() === ".git";

const listed = async (pending: Pending): Promise<Listed> => {
  const entries = await readdir(pending.dir, { withFileTypes: true }).catch(() => [] as Dirent[]);

  return { ...pending, entries, boundary: entries.some((entry) => isGitName(entry.name)) };
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

const childrenOf = (level: Listed): Pending[] => {
  const owners = level.boundary ? [...level.owners, level.dir] : level.owners;
  const underLockfile = hasNodeLockfile(level) || (!level.boundary && level.underLockfile);
  const marked = overlaysMarkedBy(level.entries.map((entry) => entry.name));

  return level.entries
    .filter((entry) => isWalked(entry) && !marked.includes(entry.name))
    .map((entry) => ({ dir: join(level.dir, entry.name), owners, underLockfile }));
};

const withPackages = (levels: Listed[], root: string, walk: Walk) =>
  levels.filter(isPackage).reduce((state, level) => {
    const repo = repoOf(level, root);
    const count = state.packages[repo] ?? 0;

    return count >= PACKAGES_PER_REPO
      ? state
      : {
          overlays: [...state.overlays, join(level.dir, NODE_OVERLAY)],
          packages: { ...state.packages, [repo]: count + 1 },
        };
  }, walk);

const folded =
  (root: string) =>
  (walk: Walk, levels: Listed[]): Walk =>
    withPackages(levels, root, { ...walk, overlays: [...walk.overlays, ...levels.flatMap(markedOverlays)] });

export const scanOverlays = async (root: string, budget = SCAN_BUDGET): Promise<OverlayScan> => {
  const { state, complete } = await walkLevels(
    [{ dir: root, owners: [], underLockfile: false }],
    budget,
    { overlays: [], packages: {} } as Walk,
    { list: listed, children: childrenOf, fold: folded(root) },
  );

  return { overlays: state.overlays.sort(), truncated: !complete };
};
