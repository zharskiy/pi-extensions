import type { Dirent } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { expandHome, isWithin, printable, realOrResolved, realOrResolvedSync } from "../../shared/index.ts";
import {
  checkRoot,
  pathTextProblem,
  type RootGuardContext,
  type RootProblem,
} from "../../workspace/index.ts";
import type { FolderCandidate } from "./types.ts";

interface ScanLimits {
  maxRepos: number;
  maxEntries: number;
  budgetMs: number;
  now: () => number;
}

interface ScanState {
  repos: number;
  entries: number;
  capped: boolean;
  latest?: { path: string; mtimeMs: number };
}

interface Scan {
  repos: number;
  capped: boolean;
  latestRepo?: string;
}

export interface CandidateContext extends RootGuardContext {
  cwd: string;
  configRoot: string | undefined;
  firstRun: boolean;
  limits?: Partial<ScanLimits>;
}

interface Proposed {
  stored: string;
  origin: FolderCandidate["origin"];
}

export const USUAL_FOLDERS = [
  "Projects",
  "projects",
  "Developer",
  "Code",
  "code",
  "src",
  "dev",
  "Dev",
  "work",
  "Work",
  "git",
  "GitHub",
  "github",
  "repos",
  "Repos",
  "workspace",
  "Workspace",
  "Sites",
];

const MAX_DETECTED = 8;

const MAX_SUGGESTION_DISTANCE = 2;

const DEFAULT_LIMITS: ScanLimits = { maxRepos: 50, maxEntries: 4000, budgetMs: 400, now: Date.now };

const isHomeForm = (path: string) => path === "~" || path.startsWith("~/");

const withoutTrailingSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

export const tildeForm = (path: string, home: string) => {
  if (isHomeForm(path)) {
    return withoutTrailingSlash(path);
  }

  const absolute = withoutTrailingSlash(resolve(path));

  if (absolute === home) {
    return "~";
  }

  return isWithin(absolute, home) ? `~/${relative(home, absolute)}` : absolute;
};

const shownPath = (path: string, home: string) => printable(tildeForm(path, home));

const isFolder = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const refusedRoot = (stored: string, home: string) => realOrResolvedSync(resolve(expandHome(stored, home)));

const rootOf = (stored: string, context: RootGuardContext) => {
  const verdict = checkRoot(stored, context);

  if (verdict.ok) {
    return { resolved: verdict.resolved, exists: verdict.exists };
  }

  const resolved = refusedRoot(stored, context.home);

  return { resolved, exists: isFolder(resolved) };
};

const isScannable = (entry: Dirent) =>
  entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules";

const listing = async (dir: string) => readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);

const gitTime = async (dir: string) => {
  const info = await lstat(join(dir, ".git")).catch(() => undefined);

  return info === undefined ? undefined : info.mtimeMs;
};

const isSpent = (state: ScanState, limits: ScanLimits, started: number) =>
  state.repos >= limits.maxRepos ||
  state.entries >= limits.maxEntries ||
  limits.now() - started >= limits.budgetMs;

const counted = (state: ScanState, path: string, mtimeMs: number): ScanState => ({
  ...state,
  repos: state.repos + 1,
  latest: state.latest === undefined || mtimeMs > state.latest.mtimeMs ? { path, mtimeMs } : state.latest,
});

const visit = async (state: ScanState, dir: string, depth: number, limits: ScanLimits, started: number) => {
  if (isSpent(state, limits, started)) {
    return { ...state, capped: true };
  }

  const mtimeMs = await gitTime(dir);

  if (mtimeMs !== undefined) {
    return counted(state, dir, mtimeMs);
  }

  return depth === 0 ? state : visitChildren(state, dir, depth - 1, limits, started);
};

const visitChildren = async (
  state: ScanState,
  dir: string,
  depth: number,
  limits: ScanLimits,
  started: number,
): Promise<ScanState> => {
  const entries = await listing(dir);
  const listed = { ...state, entries: state.entries + entries.length };

  return entries
    .filter(isScannable)
    .reduce<Promise<ScanState>>(
      async (previous, entry) => visit(await previous, join(dir, entry.name), depth, limits, started),
      Promise.resolve(listed),
    );
};

export const scanRepos = async (dir: string, limits: Partial<ScanLimits> = {}): Promise<Scan> => {
  const chosen = { ...DEFAULT_LIMITS, ...limits };
  const state = await visitChildren({ repos: 0, entries: 0, capped: false }, dir, 1, chosen, chosen.now());
  const capped = state.capped || state.repos >= chosen.maxRepos;

  return state.latest === undefined
    ? { repos: state.repos, capped }
    : { repos: state.repos, capped, latestRepo: state.latest.path };
};

const isFolderLater = async (path: string) =>
  (await stat(path).catch(() => undefined))?.isDirectory() === true;

const acceptable = async (path: string, context: RootGuardContext) => {
  if (!(await isFolderLater(path))) {
    return false;
  }

  const verdict = checkRoot(path, context);

  return verdict.ok && verdict.exists;
};

export const rootFromEnv = (env: NodeJS.ProcessEnv, cwd: string) => {
  const root = env.PINATA_ROOT ?? "";

  if (root === "") {
    return undefined;
  }

  return isAbsolute(root) || isHomeForm(root) ? withoutTrailingSlash(root) : resolve(cwd, root);
};

const envRoot = (context: CandidateContext): Proposed[] => {
  const stored = rootFromEnv(context.env, context.cwd);

  return stored === undefined ? [] : [{ stored, origin: "env" }];
};

const fixedRoots = (context: CandidateContext): Proposed[] => [
  ...(context.configRoot === undefined ? [] : [{ stored: context.configRoot, origin: "config" as const }]),
  ...(context.firstRun ? envRoot(context) : []),
];

const cwdFolder = async (context: CandidateContext): Promise<Proposed[]> => {
  const below = relative(context.home, context.cwd);

  if (below === "" || !isWithin(context.cwd, context.home)) {
    return [];
  }

  const top = join(context.home, below.split(sep)[0] ?? "");

  return (await acceptable(top, context)) ? [{ stored: tildeForm(top, context.home), origin: "cwd" }] : [];
};

const usualFolders = async (context: CandidateContext): Promise<Proposed[]> => {
  const paths = USUAL_FOLDERS.map((name) => join(context.home, name));
  const kept = await Promise.all(paths.map((path) => acceptable(path, context)));

  return paths
    .filter((_path, index) => kept[index])
    .map((path) => ({ stored: tildeForm(path, context.home), origin: "usual" as const }));
};

const candidateOf = async (proposed: Proposed, context: CandidateContext): Promise<FolderCandidate> => {
  const resolved = await realOrResolved(expandHome(proposed.stored, context.home));
  const exists = await isFolderLater(resolved);
  const scan = exists ? await scanRepos(resolved, context.limits) : { repos: 0, capped: false };
  const cwd = await realpath(context.cwd).catch(() => context.cwd);

  return {
    stored: proposed.stored,
    resolved,
    exists,
    repos: scan.repos,
    capped: scan.capped,
    origin: proposed.origin,
    here: isWithin(cwd, resolved),
    ...(scan.latestRepo === undefined ? {} : { latestRepo: scan.latestRepo }),
  };
};

export const unscannedCandidates = (context: CandidateContext): FolderCandidate[] =>
  fixedRoots(context).map((proposed) => ({
    stored: proposed.stored,
    ...rootOf(proposed.stored, context),
    repos: 0,
    capped: false,
    origin: proposed.origin,
    here: false,
  }));

const distinct = (candidates: FolderCandidate[]) =>
  candidates.filter(
    (candidate, index) => candidates.findIndex((other) => other.resolved === candidate.resolved) === index,
  );

const byRepos = (left: FolderCandidate, right: FolderCandidate) =>
  right.repos - left.repos || left.stored.localeCompare(right.stored);

export const folderCandidates = async (context: CandidateContext): Promise<FolderCandidate[]> => {
  const proposed = [...fixedRoots(context), ...(await cwdFolder(context)), ...(await usualFolders(context))];
  const all = distinct(await Promise.all(proposed.map((entry) => candidateOf(entry, context))));
  const fixed = all.filter((candidate) => candidate.origin === "config" || candidate.origin === "env");
  const detected = all
    .filter((candidate) => candidate.origin === "cwd" || candidate.origin === "usual")
    .sort(byRepos)
    .slice(0, MAX_DETECTED);

  return [...fixed, ...detected];
};

const nextRow = (row: number[], leftChar: string, leftIndex: number, right: string) =>
  Array.from(right).reduce(
    (next, rightChar, rightIndex) => {
      next.push(
        Math.min(
          (row[rightIndex + 1] ?? 0) + 1,
          (next[rightIndex] ?? 0) + 1,
          (row[rightIndex] ?? 0) + (leftChar === rightChar ? 0 : 1),
        ),
      );

      return next;
    },
    [leftIndex + 1],
  );

const distance = (left: string, right: string) => {
  const first = Array.from({ length: right.length + 1 }, (_, index) => index);
  const last = Array.from(left).reduce(
    (row, leftChar, leftIndex) => nextRow(row, leftChar, leftIndex, right),
    first,
  );

  return last[right.length] ?? 0;
};

const folderNames = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

const isRelated = (other: string, name: string) => {
  if (other.toLowerCase() === name.toLowerCase()) {
    return true;
  }

  const allowed = Math.min(MAX_SUGGESTION_DISTANCE, Math.floor(name.length / 3));

  return (name.startsWith(".") || !other.startsWith(".")) && distance(other, name) <= allowed;
};

export const suggestionFor = (path: string, context: RootGuardContext) => {
  const name = basename(path);
  const near = folderNames(dirname(path)).filter(
    (other) => other !== name && isRelated(other, name) && checkRoot(join(dirname(path), other), context).ok,
  );

  return near.length === 0 ? undefined : join(dirname(path), near.sort()[0] ?? "");
};

const guardMessage = (shown: string, problem: RootProblem, resolved = "") => {
  if (problem.kind === "control") {
    return "That path has a control character in it.";
  }

  if (problem.kind === "mount-syntax") {
    return `${shown} has a "," or ":" in its name, which the VM cannot share. Rename it or choose another folder.`;
  }

  if (problem.kind === "home") {
    return `${shown} is your home or holds it, and the sandbox VM must not see all of it. Choose the folder in it that holds your projects.`;
  }

  if (problem.path === resolved) {
    return `${shown} cannot be shared: the sandbox must never see it, since it holds secrets or system files. Choose another folder.`;
  }

  return problem.kind === "inside"
    ? `${shown} lies inside ${problem.name}, which the sandbox must never see.`
    : `${shown} holds ${problem.name}, which the sandbox must never see. Choose a folder inside it.`;
};

export const refusedRootMessage = (stored: string, context: RootGuardContext) => {
  const verdict = checkRoot(stored, context);

  return verdict.ok
    ? undefined
    : guardMessage(shownPath(stored, context.home), verdict.problem, refusedRoot(stored, context.home));
};

const missingMessage = (shown: string, resolved: string, context: RootGuardContext) => {
  const suggestion = suggestionFor(resolved, context);

  return suggestion === undefined
    ? `${shown} does not exist.`
    : `${shown} does not exist. Did you mean ${shownPath(suggestion, context.home)}?`;
};

const existingMessage = (shown: string, resolved: string, context: RootGuardContext) => {
  const info = statSync(resolved, { throwIfNoEntry: false });

  if (info === undefined) {
    return missingMessage(shown, resolved, context);
  }

  return info.isDirectory() ? undefined : `${shown} is a file, not a folder.`;
};

export const typedRootProblem = (typed: string, context: RootGuardContext) => {
  const trimmed = typed.trim();

  if (trimmed === "" || trimmed === "~/") {
    return "Type the path of a folder.";
  }

  if (!isAbsolute(trimmed) && !isHomeForm(trimmed)) {
    return "Type a full path, starting with / or ~/.";
  }

  const shown = shownPath(trimmed, context.home);
  const textProblem = pathTextProblem(trimmed);

  if (textProblem !== undefined) {
    return guardMessage(shown, textProblem);
  }

  const verdict = checkRoot(trimmed, context);

  return verdict.ok
    ? existingMessage(shown, verdict.resolved, context)
    : guardMessage(shown, verdict.problem, refusedRoot(trimmed, context.home));
};

export const sameRoot = (left: string, right: string, context: RootGuardContext) =>
  rootOf(left, context).resolved === rootOf(right, context).resolved;
