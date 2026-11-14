import type { Dirent } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { expandHome, isWithin, realOrResolvedSync } from "../../shared/index.ts";
import { checkRoot, type RootGuardContext, type RootProblem, sharedRootsOf } from "../../workspace/index.ts";
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
  configRoots: string[] | undefined;
  firstRun: boolean;
  limits?: Partial<ScanLimits>;
}

interface Proposed {
  stored: string;
  origin: FolderCandidate["origin"];
}

export interface AddContext extends RootGuardContext {
  checked: string[];
  listed: string[];
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

const ROOTS_SEPARATOR = ":";

const CONTROL_CHARACTER = /\p{Cc}/u;

const MOUNT_SYNTAX = /[,:]/;

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

const resolvedRoot = (stored: string, home: string) =>
  realOrResolvedSync(resolve(expandHome(stored, home)));

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

const isFolder = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const acceptable = (path: string, context: RootGuardContext) => {
  const verdict = checkRoot(path, context);

  return verdict.ok && verdict.exists;
};

export const rootsFromEnv = (env: NodeJS.ProcessEnv, cwd: string) =>
  (env.PI_SANDBOX_ROOTS ?? "")
    .split(ROOTS_SEPARATOR)
    .filter((root) => root !== "")
    .map((root) => (isAbsolute(root) || isHomeForm(root) ? withoutTrailingSlash(root) : resolve(cwd, root)));

const envRoots = (context: CandidateContext): Proposed[] =>
  rootsFromEnv(context.env, context.cwd).map((stored) => ({ stored, origin: "env" as const }));

const cwdFolder = (context: CandidateContext): Proposed[] => {
  const below = relative(context.home, context.cwd);

  if (below === "" || !isWithin(context.cwd, context.home)) {
    return [];
  }

  const top = join(context.home, below.split(sep)[0] ?? "");

  return acceptable(top, context) ? [{ stored: tildeForm(top, context.home), origin: "cwd" }] : [];
};

const usualFolders = (context: CandidateContext): Proposed[] =>
  USUAL_FOLDERS.map((name) => join(context.home, name))
    .filter((path) => acceptable(path, context))
    .map((path) => ({ stored: tildeForm(path, context.home), origin: "usual" as const }));

const candidateOf = async (proposed: Proposed, context: CandidateContext): Promise<FolderCandidate> => {
  const resolved = resolvedRoot(proposed.stored, context.home);
  const exists = isFolder(resolved);
  const scan = exists ? await scanRepos(resolved, context.limits) : { repos: 0, capped: false };

  return {
    stored: proposed.stored,
    resolved,
    exists,
    repos: scan.repos,
    capped: scan.capped,
    origin: proposed.origin,
    here: isWithin(realOrResolvedSync(context.cwd), resolved),
    ...(scan.latestRepo === undefined ? {} : { latestRepo: scan.latestRepo }),
  };
};

const distinct = (candidates: FolderCandidate[]) =>
  candidates.filter(
    (candidate, index) => candidates.findIndex((other) => other.resolved === candidate.resolved) === index,
  );

const byRepos = (left: FolderCandidate, right: FolderCandidate) =>
  right.repos - left.repos || left.stored.localeCompare(right.stored);

export const folderCandidates = async (context: CandidateContext): Promise<FolderCandidate[]> => {
  const configured = (context.configRoots ?? []).map((stored) => ({ stored, origin: "config" as const }));
  const fromEnv = context.firstRun ? envRoots(context) : [];
  const proposed = [...configured, ...fromEnv, ...cwdFolder(context), ...usualFolders(context)];
  const all = distinct(await Promise.all(proposed.map((entry) => candidateOf(entry, context))));
  const fixed = all.filter((candidate) => candidate.origin === "config" || candidate.origin === "env");
  const detected = all
    .filter((candidate) => candidate.origin === "cwd" || candidate.origin === "usual")
    .sort(byRepos)
    .slice(0, MAX_DETECTED);

  return [...fixed, ...detected];
};

export const isPreChecked = (candidate: FolderCandidate, firstRun: boolean) => {
  if (candidate.origin === "config" || candidate.origin === "env") {
    return true;
  }

  if (!firstRun) {
    return false;
  }

  return candidate.origin === "cwd" || candidate.repos > 0;
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

export const suggestionFor = (path: string) => {
  const name = basename(path);
  const lowered = name.toLowerCase();
  const near = folderNames(dirname(path)).filter(
    (other) =>
      other !== name && (other.toLowerCase() === lowered || distance(other, name) <= MAX_SUGGESTION_DISTANCE),
  );

  return near.length === 0 ? undefined : join(dirname(path), near.sort()[0] ?? "");
};

const guardMessage = (shown: string, problem: RootProblem) => {
  if (problem.kind === "control") {
    return "That path has a control character in it.";
  }

  if (problem.kind === "mount-syntax") {
    return `${shown} has a "," or ":" in its name, which the VM cannot share. Rename it or choose another folder.`;
  }

  if (problem.kind === "home") {
    return `${shown} is your whole home. Choose the folders inside it that hold projects.`;
  }

  return problem.kind === "inside"
    ? `${shown} lies inside ${problem.name}, which the sandbox must never see.`
    : `${shown} holds ${problem.name}, which the sandbox must never see. Choose a folder inside it.`;
};

const missingMessage = (shown: string, resolved: string, home: string) => {
  const suggestion = suggestionFor(resolved);

  return suggestion === undefined
    ? `${shown} does not exist.`
    : `${shown} does not exist. Did you mean ${tildeForm(suggestion, home)}?`;
};

const nestingMessage = (shown: string, resolved: string, context: AddContext) => {
  const outer = context.checked.find((other) => isWithin(resolved, resolvedRoot(other, context.home)));

  if (outer !== undefined) {
    return `${shown} lies inside ${outer}, which is already selected.`;
  }

  const inner = context.checked.find((other) => isWithin(resolvedRoot(other, context.home), resolved));

  return inner === undefined
    ? undefined
    : `${shown} holds ${inner}, which is selected. Unselect ${inner} first, or choose another folder.`;
};

const existingMessage = (shown: string, resolved: string, home: string) => {
  const info = statSync(resolved, { throwIfNoEntry: false });

  if (info === undefined) {
    return missingMessage(shown, resolved, home);
  }

  return info.isDirectory() ? undefined : `${shown} is a file, not a folder.`;
};

export const addedRootProblem = (typed: string, context: AddContext) => {
  const trimmed = typed.trim();

  if (trimmed === "" || trimmed === "~" || trimmed === "~/") {
    return "Type the path of a folder.";
  }

  if (!isAbsolute(trimmed) && !isHomeForm(trimmed)) {
    return "Type a full path, starting with / or ~/.";
  }

  if (CONTROL_CHARACTER.test(trimmed)) {
    return "That path has a control character in it.";
  }

  const shown = tildeForm(trimmed, context.home);

  if (MOUNT_SYNTAX.test(trimmed)) {
    return guardMessage(shown, { kind: "mount-syntax" });
  }

  const resolved = resolvedRoot(trimmed, context.home);
  const verdict = checkRoot(trimmed, context);

  if (!verdict.ok) {
    return guardMessage(shown, verdict.problem);
  }

  if (context.listed.some((other) => resolvedRoot(other, context.home) === resolved)) {
    return `${shown} is already in the list.`;
  }

  return existingMessage(shown, resolved, context.home) ?? nestingMessage(shown, resolved, context);
};

const sharedSet = (roots: string[], context: RootGuardContext) => {
  const shared = sharedRootsOf({ roots }, context);

  return [...new Set([...shared.roots, ...shared.missing])].sort();
};

export const sameRootSet = (left: string[], right: string[], context: RootGuardContext) =>
  JSON.stringify(sharedSet(left, context)) === JSON.stringify(sharedSet(right, context));
