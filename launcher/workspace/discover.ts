import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type CommandRunner,
  errorMessage,
  isWithin,
  LauncherError,
  lstatOrUndefined,
  readRegularFile,
} from "../shared/index.ts";
import { inertGitOptions } from "./git/command.ts";
import { findGitRoot, gitDirHolding, gitLayoutAt, isGitName, lexicalGitLayout } from "./git/layout.ts";
import { realOrPending, resolvedOnDisk } from "./paths.ts";
import { type DetachedCheckout, gitDirsOf, type Workspace } from "./types.ts";
import { SCAN_BUDGET, scanWorkspace, type WorkspaceScan } from "./workspace-scan.ts";

export interface DiscoverOptions {
  lenient?: boolean;
  overlays?: boolean;
  scanBudget?: number;
}

export interface WorkspaceFolder {
  realCwd: string;
  root?: string;
}

const NARROWER = "start pi in a narrower folder";

const MAX_NESTED_REPOS = 128;

const MAX_OVERLAYS = 512;

const realPath = async (path: string) => {
  try {
    return await realpath(path);
  } catch (error) {
    throw new LauncherError(`${path}: ${errorMessage(error)}`);
  }
};

const mismatch = (dotGit: string, found: string, reported: string) =>
  new LauncherError(
    `git: ${dotGit} leads to ${found}, but git reports ${reported}; refusing to mount a git dir git did not choose`,
    "check the repository's .git and commondir files and git's core.worktree setting",
  );

const unconfirmed = (dotGit: string, found: string) =>
  new LauncherError(
    `git: ${dotGit} leads to ${found}, but git does not open it as a repository; refusing to mount it`,
    "check the repository's .git file and run git status in it",
  );

const unprotected = (repo: string, error: unknown) =>
  new LauncherError(
    `workspace: ${repo} cannot be protected: ${errorMessage(error)}`,
    "fix or move that repository, or start pi inside it",
  );

const caseVariant = (path: string) =>
  new LauncherError(
    `workspace: ${path} is a letter-case variant of .git, which git opens as a repository on a case-insensitive volume, refusing`,
    "rename it to .git or remove it",
  );

const unreadableFolder = (cwd: string, code: string) =>
  new LauncherError(
    `workspace: cannot read ${cwd} (${code}), refusing`,
    "make it readable (chmod u+rx) or start pi in another folder",
  );

const bareCwd = (cwd: string) =>
  new LauncherError(
    `workspace: ${cwd} is a git dir, refusing`,
    "start pi in a checkout of it or in the folder above",
  );

const tooManyRepos = (root: string, count: number) =>
  new LauncherError(
    `workspace: ${root} holds ${count} repositories, more than the ${MAX_NESTED_REPOS} the launcher protects`,
    NARROWER,
  );

const tooLarge = (root: string, budget: number) =>
  new LauncherError(
    `workspace: ${root} has more than ${budget} directories to search for repositories, refusing`,
    NARROWER,
  );

const insideGitDir = (cwd: string, gitDir: string) =>
  new LauncherError(
    `workspace: ${cwd} lies inside the git dir ${gitDir}, refusing`,
    "start pi in a repository's checkout or in a folder outside its git dir",
  );

const realOrUndefined = (path: string) => realpath(path).catch(() => undefined);

const splitsOf = (stdout: string) => {
  const lines = stdout.replace(/\n$/, "").split("\n");

  return lines.slice(1).map((_, index) => ({
    toplevel: lines.slice(0, index + 1).join("\n"),
    commonDir: lines.slice(index + 1).join("\n"),
  }));
};

const resolvedSplit = async (cwd: string, split: { toplevel: string; commonDir: string }) => {
  const [repoRoot, gitCommonDir] = await Promise.all([
    realOrUndefined(split.toplevel),
    realOrUndefined(resolve(cwd, split.commonDir)),
  ]);

  return split.toplevel === "" ||
    split.commonDir === "" ||
    repoRoot === undefined ||
    gitCommonDir === undefined
    ? []
    : [{ repoRoot, gitCommonDir }];
};

const reportedByGit = async (cwd: string, runner: CommandRunner, emptyHooksDir: string) => {
  const result = await runner.run(
    "git",
    [...inertGitOptions(emptyHooksDir), "rev-parse", "--show-toplevel", "--git-common-dir"],
    { cwd },
  );

  if (result.code !== 0) {
    return undefined;
  }

  const found = await Promise.all(splitsOf(result.stdout).map((split) => resolvedSplit(cwd, split)));

  return found.flat().at(0);
};

const confirmedRepo = async (
  root: string,
  cwd: string,
  runner: CommandRunner,
  emptyHooksDir: string,
): Promise<Workspace> => {
  const layout = await gitLayoutAt(root);
  const reported = await reportedByGit(cwd, runner, emptyHooksDir);

  if (reported === undefined) {
    throw unconfirmed(join(root, ".git"), layout.gitCommonDir);
  }

  if (reported.repoRoot !== root || reported.gitCommonDir !== layout.gitCommonDir) {
    throw mismatch(
      join(root, ".git"),
      layout.gitCommonDir,
      `${reported.repoRoot} with ${reported.gitCommonDir}`,
    );
  }

  return {
    cwd,
    repoRoot: root,
    gitDir: layout.gitDir,
    gitCommonDir: layout.gitCommonDir,
    isGitRepo: true,
  };
};

const lenientRepo = async (root: string, cwd: string): Promise<Workspace> => {
  const layout = await gitLayoutAt(root).catch(() => lexicalGitLayout(root));

  return { cwd, repoRoot: root, gitDir: layout.gitDir, gitCommonDir: layout.gitCommonDir, isGitRepo: true };
};

const assertExactDotGit = async (root: string) => {
  const names = await readdir(root).catch(() => [".git"]);
  const variant = names.find((name) => name !== ".git" && isGitName(name));

  if (!names.includes(".git") && variant !== undefined) {
    throw caseVariant(join(root, variant));
  }
};

const singleRepo = async (root: string, cwd: string, runner: CommandRunner, emptyHooksDir: string) => {
  await Promise.all([assertExactDotGit(root), assertOutsideGitDirs(cwd, root)]);

  return confirmedRepo(root, cwd, runner, emptyHooksDir);
};

const GIT_FILE_PREFIX = "gitdir: ";

const pointerText = async (path: string) => {
  const text = await readRegularFile(path).then(
    (file) => file.data.toString("utf8"),
    () => "",
  );

  return text.startsWith(GIT_FILE_PREFIX)
    ? text.slice(GIT_FILE_PREFIX.length).replace(/[\r\n]+$/, "")
    : undefined;
};

const reachedPaths = async (base: string, text: string) => {
  const lexical = resolve(base, text);
  const [onDisk, real] = await Promise.all([resolvedOnDisk(base, text), realOrPending(lexical)]);

  return { onDisk, paths: [lexical, onDisk.path, real] };
};

const commonDirPaths = async (gitDir: string) => {
  const text = await readRegularFile(join(gitDir, "commondir")).then(
    (file) => file.data.toString("utf8").trimEnd(),
    () => "",
  );

  return text === "" || text === "." ? [] : (await reachedPaths(gitDir, text)).paths;
};

const detachedCheckout = async (repo: string, root: string): Promise<DetachedCheckout | undefined> => {
  const dotGit = join(repo, ".git");
  const text = (await lstatOrUndefined(dotGit))?.isFile() === true ? await pointerText(dotGit) : undefined;

  if (text === undefined) {
    return undefined;
  }

  const gitDir = await reachedPaths(repo, text);
  const { missing } = gitDir.onDisk;
  const reached = [...gitDir.paths, ...(missing ? [] : await commonDirPaths(gitDir.onDisk.path))];
  const inside = reached.every((path) => isWithin(path, root));

  return missing || !inside ? { repoRoot: repo, missing } : undefined;
};

type Found = { repo: Workspace } | { detached: DetachedCheckout };

const nestedRepo = async (
  repo: string,
  root: string,
  runner: CommandRunner,
  emptyHooksDir: string,
): Promise<Found> => {
  const detached = await detachedCheckout(repo, root);

  if (detached !== undefined) {
    return { detached };
  }

  const confirmed = await confirmedRepo(repo, repo, runner, emptyHooksDir).catch((error: unknown) => {
    throw unprotected(repo, error);
  });

  return gitDirsOf(confirmed).every((dir) => isWithin(dir, root))
    ? { repo: confirmed }
    : { detached: { repoRoot: repo, missing: false } };
};

const isLoose = (dir: string, repos: Workspace[]) =>
  !repos.some((repo) => [repo.repoRoot, ...gitDirsOf(repo)].some((owner) => isWithin(dir, owner)));

const classified = async (
  root: string,
  scan: WorkspaceScan,
  runner: CommandRunner,
  emptyHooksDir: string,
) => {
  const found = await Promise.all(scan.repos.map((repo) => nestedRepo(repo, root, runner, emptyHooksDir)));
  const live = found.flatMap((entry) => ("repo" in entry ? [entry.repo] : []));

  return {
    live,
    detached: found.flatMap((entry) => ("detached" in entry ? [entry.detached] : [])),
    bare: scan.bare.filter((dir) => isLoose(dir, live)),
  };
};

const overlaysOf = (scan: WorkspaceScan) =>
  scan.overlays.length > MAX_OVERLAYS ? { overlays: [], overlaysCapped: true } : { overlays: scan.overlays };

const overlaysFound = (
  scan: WorkspaceScan | undefined,
): Pick<Workspace, "overlays" | "overlaysCapped" | "overlaysTruncated"> => {
  if (scan === undefined) {
    return { overlays: [] };
  }

  return scan.truncated ? { overlays: [], overlaysTruncated: true } : overlaysOf(scan);
};

const assertOutsideGitDirs = async (cwd: string, root?: string) => {
  const holding = await gitDirHolding(cwd);

  if (holding === undefined || (root !== undefined && (holding === root || !isWithin(holding, root)))) {
    return;
  }

  throw holding === cwd ? bareCwd(cwd) : insideGitDir(cwd, holding);
};

const isOwnedByUser = async (dir: string) => (await lstatOrUndefined(dir))?.uid === process.getuid?.();

const refusedUnreadable = async (cwd: string, scan: WorkspaceScan) => {
  const owned = await Promise.all(
    scan.unreadable.map(async (entry) =>
      entry.dir === cwd || (await isOwnedByUser(entry.dir)) ? [entry] : [],
    ),
  );

  return owned.flat();
};

const strictFolder = async (
  cwd: string,
  scan: WorkspaceScan,
  runner: CommandRunner,
  emptyHooksDir: string,
  budget: number,
) => {
  await assertOutsideGitDirs(cwd);

  if (scan.truncated) {
    throw tooLarge(cwd, budget);
  }

  const [variant] = scan.variants;

  if (variant !== undefined) {
    throw caseVariant(variant);
  }

  const [unreadable] = await refusedUnreadable(cwd, scan);

  if (unreadable !== undefined) {
    throw unreadableFolder(unreadable.dir, unreadable.code);
  }

  if (scan.repos.length > MAX_NESTED_REPOS) {
    throw tooManyRepos(cwd, scan.repos.length);
  }

  const found = await classified(cwd, scan, runner, emptyHooksDir);

  if (scan.repos.length + found.bare.length > MAX_NESTED_REPOS) {
    throw tooManyRepos(cwd, scan.repos.length + found.bare.length);
  }

  return {
    cwd,
    repoRoot: cwd,
    isGitRepo: false,
    nested: found.live,
    ...overlaysOf(scan),
    ...(found.detached.length === 0 ? {} : { detached: found.detached }),
    ...(found.bare.length === 0 ? {} : { bareDirs: found.bare }),
  } satisfies Workspace;
};

const repoAt = (root: string, cwd: string, runner: CommandRunner, emptyHooksDir: string, lenient: boolean) =>
  lenient ? lenientRepo(root, cwd) : singleRepo(root, cwd, runner, emptyHooksDir);

const scanned = async (root: string, mode: "workspace" | "git", options: DiscoverOptions) => {
  const overlays = options.overlays !== false;
  const scan = await scanWorkspace(root, mode, {
    overlays,
    skipOverlays: overlays,
    budget: options.scanBudget,
  });

  return mode === "workspace" && overlays && scan.overlays.length > MAX_OVERLAYS
    ? scanWorkspace(root, mode, { overlays, budget: options.scanBudget })
    : scan;
};

export const workspaceFolder = async (cwd: string): Promise<WorkspaceFolder> => {
  const realCwd = await realPath(cwd);
  const root = await findGitRoot(realCwd);

  return root === undefined ? { realCwd } : { realCwd, root };
};

export const discoverWorkspace = async (
  folder: WorkspaceFolder,
  runner: CommandRunner,
  emptyHooksDir: string,
  options: DiscoverOptions = {},
): Promise<Workspace> => {
  const { realCwd, root } = folder;
  const lenient = options.lenient === true;
  const walked = (path: string, mode: "workspace" | "git") =>
    lenient && options.overlays === false ? undefined : scanned(path, mode, options);

  if (root === undefined) {
    const scan = await walked(realCwd, "workspace");

    return lenient || scan === undefined
      ? { cwd: realCwd, repoRoot: realCwd, isGitRepo: false, ...overlaysFound(scan) }
      : strictFolder(realCwd, scan, runner, emptyHooksDir, options.scanBudget ?? SCAN_BUDGET);
  }

  const [repo, scan] = await Promise.all([
    repoAt(root, realCwd, runner, emptyHooksDir, lenient),
    options.overlays === false ? undefined : walked(root, "git"),
  ]);

  return { ...repo, ...overlaysFound(scan) };
};
