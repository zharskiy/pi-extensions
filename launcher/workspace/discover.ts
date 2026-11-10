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
import { readGitConfig } from "./git/config.ts";
import {
  findGitRoot,
  gitDirHolding,
  gitLayoutAt,
  isGitName,
  isPinText,
  lexicalGitLayout,
} from "./git/layout.ts";
import { assertWorkspaceGitConfig } from "./git/workspace.ts";
import { realOrPending, resolvedOnDisk } from "./paths.ts";
import { type DetachedCheckout, gitDirsOf, type Workspace } from "./types.ts";
import { scanBudgetOf, scanWorkspace, type WorkspaceScan } from "./workspace-scan.ts";

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

const outsideRoot = (repo: string, root: string) =>
  new LauncherError(`workspace: ${repo} uses a git dir outside ${root}`, "start pi inside it");

const revivable = (repo: string, gitDir: string) =>
  new LauncherError(
    `workspace: ${join(repo, ".git")} points at ${gitDir}, which does not exist; the sandbox could create it and make ${repo} a repository with its own hooks, refusing`,
    `delete ${join(repo, ".git")}, or run git worktree repair or git worktree prune in the repository that owns ${gitDir}`,
  );

const caseVariant = (path: string) =>
  new LauncherError(
    `workspace: ${path} is a letter-case variant of .git, which git opens as a repository on this volume, refusing`,
    "rename it to .git or remove it",
  );

const unreadableFolder = (cwd: string, code: string) =>
  new LauncherError(
    `workspace: cannot read ${cwd} (${code}), refusing`,
    "make it readable (chmod u+rx) or start pi in another folder",
  );

const bareCwd = (cwd: string) =>
  new LauncherError(
    `workspace: ${cwd} is a git dir (a bare repository), refusing`,
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

const reportedByGit = async (cwd: string, runner: CommandRunner, emptyHooksDir: string) => {
  const result = await runner.run(
    "git",
    [...inertGitOptions(emptyHooksDir), "rev-parse", "--show-toplevel", "--git-common-dir"],
    { cwd },
  );
  const [toplevel = "", commonDir = ""] = result.stdout.split("\n").map((line) => line.trim());

  if (result.code !== 0 || toplevel === "" || commonDir === "") {
    return undefined;
  }

  return { repoRoot: await realPath(toplevel), gitCommonDir: await realPath(resolve(cwd, commonDir)) };
};

const confirmedRepo = async (
  root: string,
  cwd: string,
  runner: CommandRunner,
  emptyHooksDir: string,
): Promise<Workspace> => {
  const layout = await gitLayoutAt(root, { fillEmptyPin: true });
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
  await assertExactDotGit(root);

  const repo = await confirmedRepo(root, cwd, runner, emptyHooksDir);
  const gitConfig = await readGitConfig(root, runner, emptyHooksDir, { withoutGit: "empty" });

  return { ...repo, gitConfig };
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

  return text === "" || isPinText(text) ? [] : (await reachedPaths(gitDir, text)).paths;
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
  const inside = reached.some((path) => isWithin(path, root));

  if (missing && inside) {
    throw revivable(repo, gitDir.onDisk.path);
  }

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

  const confirmed = await confirmedRepo(repo, repo, runner, emptyHooksDir)
    .then(async (found) => ({ ...found, gitConfig: await readGitConfig(repo, runner, emptyHooksDir) }))
    .catch((error: unknown) => {
      throw unprotected(repo, error);
    });

  if (!gitDirsOf(confirmed).every((dir) => isWithin(dir, root))) {
    throw outsideRoot(repo, root);
  }

  return { repo: confirmed };
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

const lenientFolder = (cwd: string, scan: WorkspaceScan): Workspace => ({
  cwd,
  repoRoot: cwd,
  isGitRepo: false,
  nested: scan.repos.map((repo) => ({ cwd: repo, repoRoot: repo, isGitRepo: true })),
  ...overlaysOf(scan),
});

const assertOutsideGitDirs = async (cwd: string) => {
  const holding = await gitDirHolding(cwd);

  if (holding === cwd) {
    throw bareCwd(cwd);
  }

  if (holding !== undefined) {
    throw insideGitDir(cwd, holding);
  }
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

  const unreadableRoot = scan.unreadable.find((entry) => entry.dir === cwd);

  if (unreadableRoot !== undefined) {
    throw unreadableFolder(cwd, unreadableRoot.code);
  }

  if (scan.repos.length > MAX_NESTED_REPOS) {
    throw tooManyRepos(cwd, scan.repos.length);
  }

  const [found, rootConfig] = await Promise.all([
    classified(cwd, scan, runner, emptyHooksDir),
    readGitConfig(cwd, runner, emptyHooksDir, { withoutGit: "empty" }),
  ]);

  if (scan.repos.length + found.bare.length > MAX_NESTED_REPOS) {
    throw tooManyRepos(cwd, scan.repos.length + found.bare.length);
  }

  const masked = scan.unreadable.map((entry) => entry.dir);
  const workspace: Workspace = {
    cwd,
    repoRoot: cwd,
    isGitRepo: false,
    nested: found.live,
    ...overlaysOf(scan),
    ...(masked.length === 0 ? {} : { masked }),
    ...(found.detached.length === 0 ? {} : { detached: found.detached }),
    ...(found.bare.length === 0 ? {} : { bareDirs: found.bare }),
  };

  await assertWorkspaceGitConfig(workspace, rootConfig);

  return workspace;
};

const repoAt = (root: string, cwd: string, runner: CommandRunner, emptyHooksDir: string, lenient: boolean) =>
  lenient ? lenientRepo(root, cwd) : singleRepo(root, cwd, runner, emptyHooksDir);

const scanned = async (root: string, mode: "workspace" | "git", options: DiscoverOptions, budget: number) => {
  const overlays = options.overlays !== false;
  const skipOverlays = overlays && options.lenient !== true;
  const scan = await scanWorkspace(root, mode, { overlays, skipOverlays, budget });

  return skipOverlays && scan.overlays.length > MAX_OVERLAYS
    ? scanWorkspace(root, mode, { overlays, budget })
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
  const budget = scanBudgetOf(options.scanBudget);

  if (root === undefined) {
    const scan = await scanned(realCwd, "workspace", options, budget);

    return options.lenient === true
      ? lenientFolder(realCwd, scan)
      : strictFolder(realCwd, scan, runner, emptyHooksDir, budget);
  }

  const [repo, scan] = await Promise.all([
    repoAt(root, realCwd, runner, emptyHooksDir, options.lenient === true),
    options.overlays === false ? undefined : scanned(root, "git", options, budget),
  ]);

  return scan === undefined ? { ...repo, overlays: [] } : { ...repo, ...overlaysOf(scan) };
};
