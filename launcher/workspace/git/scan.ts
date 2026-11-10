import type { Dirent } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { type CommandRunner, isWithin, readRegularFile, sha256Hex } from "../../shared/index.ts";
import { gitDirsOf, gitRepos, type Workspace } from "../types.ts";
import { walkLevels } from "../walk.ts";
import { SCAN_BUDGET } from "../workspace-scan.ts";
import { inertGitOptions } from "./command.ts";
import { findModuleGitDirs, findWorktreeGitDirs, hasGitDirShape, isGitName } from "./layout.ts";

export interface NestedGitEntry {
  path: string;
  kind: "directory" | "file" | "link" | "other";
  content?: string;
}

export interface GitFileDigest {
  path: string;
  digest: string;
}

export interface GitBaseline {
  gitlinks: string[];
  nested: NestedGitEntry[];
  own: GitFileDigest[];
  complete: boolean;
  budget: number;
}

const GITLINK_PREFIX = "160000 ";

const REVIEW = "review it before running host git tools in this repository";

const gitlinksOf = async (
  workspace: Workspace,
  gitCommonDir: string,
  runner: CommandRunner,
  emptyHooksDir: string,
) => {
  const args = [
    ...inertGitOptions(emptyHooksDir),
    `--git-dir=${workspace.gitDir ?? gitCommonDir}`,
    `--work-tree=${workspace.repoRoot}`,
    "ls-files",
    "--stage",
    "-z",
  ];
  const result = await runner.run("git", args, { cwd: workspace.repoRoot }).catch(() => undefined);

  if (result?.code !== 0) {
    return [];
  }

  return result.stdout
    .split("\0")
    .filter((record) => record.startsWith(GITLINK_PREFIX))
    .map((record) => join(workspace.repoRoot, record.slice(record.indexOf("\t") + 1)))
    .sort();
};

const kindOf = (entry: Dirent): NestedGitEntry["kind"] => {
  if (entry.isDirectory()) {
    return "directory";
  }

  if (entry.isFile()) {
    return "file";
  }

  return entry.isSymbolicLink() ? "link" : "other";
};

const RUN_FILES = ["config", "config.worktree", "commondir"];

const fileText = (path: string) =>
  readRegularFile(path).then(
    (file) => file.data.toString("utf8"),
    () => "",
  );

const entryDigest = async (path: string, entry: Dirent) => {
  if (entry.isFile()) {
    return `file ${sha256Hex(await fileText(path))}`;
  }

  return entry.isSymbolicLink() ? `link ${await readlink(path).catch(() => "")}` : kindOf(entry);
};

const gitDirDigest = async (dir: string) => {
  const hooks = await readdir(join(dir, "hooks"), { withFileTypes: true }).catch((): Dirent[] => []);
  const lines = await Promise.all([
    ...RUN_FILES.map(async (name) => `${name} ${sha256Hex(await fileText(join(dir, name)))}`),
    ...hooks.map(
      async (entry) => `hooks/${entry.name} ${await entryDigest(join(dir, "hooks", entry.name), entry)}`,
    ),
  ]);

  return sha256Hex(lines.sort().join("\n"));
};

const MISSING = "missing";

const pathDigest = async (path: string): Promise<string> => {
  const info = await lstat(path).catch(() => undefined);

  if (info === undefined) {
    return MISSING;
  }

  if (info.isFile()) {
    return `file ${sha256Hex(await fileText(path))}`;
  }

  if (info.isSymbolicLink()) {
    return `link ${await readlink(path).catch(() => "")}`;
  }

  if (!info.isDirectory()) {
    return "other";
  }

  const entries = await readdir(path, { withFileTypes: true }).catch((): Dirent[] => []);
  const lines = await Promise.all(
    entries.map(async (entry) => `${entry.name} ${await entryDigest(join(path, entry.name), entry)}`),
  );

  return `directory ${sha256Hex(lines.sort().join("\n"))}`;
};

const GIT_DIR_FILES = ["config", "config.worktree", "commondir", "hooks"];

const WORKTREE_FILES = ["commondir", "gitdir", "config.worktree"];

const ownGitPaths = async (repo: Workspace) => {
  const gitCommonDir = repo.gitCommonDir;

  if (gitCommonDir === undefined) {
    return [];
  }

  const [worktrees, modules] = await Promise.all([
    findWorktreeGitDirs(gitCommonDir).catch(() => []),
    findModuleGitDirs(gitCommonDir).catch(() => []),
  ]);
  const dotGit = join(repo.repoRoot, ".git");

  return [
    ...[gitCommonDir, ...modules].flatMap((dir) => GIT_DIR_FILES.map((name) => join(dir, name))),
    ...worktrees.flatMap((dir) => WORKTREE_FILES.map((name) => join(dir, name))),
    ...((repo.gitDir ?? gitCommonDir) === dotGit ? [] : [dotGit]),
  ];
};

const ownGitFiles = async (repos: Workspace[]): Promise<GitFileDigest[]> => {
  const paths = [...new Set((await Promise.all(repos.map(ownGitPaths))).flat())].sort();
  const digests = await Promise.all(paths.map(pathDigest));

  return paths.map((path, index) => ({ path, digest: digests[index] ?? MISSING }));
};

const contentOf = (path: string, kind: NestedGitEntry["kind"]) => {
  if (kind === "file") {
    return fileText(path);
  }

  if (kind === "directory") {
    return gitDirDigest(path);
  }

  return kind === "link" ? readlink(path).catch(() => "") : Promise.resolve(undefined);
};

const describe = async (path: string, entry: Dirent): Promise<NestedGitEntry> => {
  const kind = kindOf(entry);
  const content = await contentOf(path, kind);

  return content === undefined ? { path, kind } : { path, kind, content };
};

interface Level {
  found: NestedGitEntry[];
  next: string[];
}

const listedIn =
  (skipped: Set<string>) =>
  async (dir: string): Promise<Level> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);

    if (hasGitDirShape(entries.map((entry) => entry.name))) {
      return { found: [{ path: dir, kind: "directory", content: await gitDirDigest(dir) }], next: [] };
    }

    const found = await Promise.all(
      entries
        .filter((entry) => isGitName(entry.name) && !skipped.has(join(dir, entry.name)))
        .map((entry) => describe(join(dir, entry.name), entry)),
    );
    const next = entries
      .filter((entry) => entry.isDirectory() && !isGitName(entry.name))
      .map((entry) => join(dir, entry.name))
      .filter((path) => !skipped.has(path));

    return { found, next };
  };

const gitPathsOf = (repo: Workspace) => [join(repo.repoRoot, ".git"), ...gitDirsOf(repo)];

const repoGitlinks = (repo: Workspace, runner: CommandRunner, emptyHooksDir: string) =>
  repo.gitCommonDir === undefined
    ? Promise.resolve([])
    : gitlinksOf(repo, repo.gitCommonDir, runner, emptyHooksDir);

export const scanGitBaseline = async (
  workspace: Workspace,
  runner: CommandRunner,
  emptyHooksDir: string,
  scanBudget?: number,
  volumePaths: string[] = [],
): Promise<GitBaseline> => {
  const budget = scanBudget ?? SCAN_BUDGET;

  if (workspace.isGitRepo && workspace.gitCommonDir === undefined) {
    return { gitlinks: [], nested: [], own: [], complete: true, budget };
  }

  const repos = gitRepos(workspace);
  const volumes = volumePaths.filter(
    (path) => path !== workspace.repoRoot && isWithin(path, workspace.repoRoot),
  );
  const skipped = new Set([...repos.flatMap(gitPathsOf), ...volumes, ...(workspace.bareDirs ?? [])]);
  const [walk, gitlinks, own] = await Promise.all([
    walkLevels([workspace.repoRoot], budget, [] as NestedGitEntry[], {
      list: listedIn(skipped),
      children: (level) => level.next,
      fold: (found, levels) => [...found, ...levels.flatMap((level) => level.found)],
    }),
    Promise.all(repos.map((repo) => repoGitlinks(repo, runner, emptyHooksDir))),
    ownGitFiles(repos),
  ]);

  return {
    gitlinks: gitlinks.flat().sort(),
    nested: walk.state,
    own,
    complete: walk.complete,
    budget,
  };
};

const changed = (before: NestedGitEntry | undefined, after: NestedGitEntry) =>
  before === undefined || before.kind !== after.kind || before.content !== after.content;

const changedOwn = (before: GitFileDigest[], after: GitFileDigest[]) => {
  const digestIn = (list: GitFileDigest[]) => new Map(list.map((entry) => [entry.path, entry.digest]));
  const [was, now] = [digestIn(before), digestIn(after)];
  const paths = [...new Set([...was.keys(), ...now.keys()])].sort();

  return paths.filter((path) => (was.get(path) ?? MISSING) !== (now.get(path) ?? MISSING));
};

export const nestedGitNotices = (before: GitBaseline, after: GitBaseline) => {
  const known = new Map(before.nested.map((entry) => [entry.path, entry]));
  const entries = after.nested.filter((entry) => changed(known.get(entry.path), entry));
  const gitlinks = after.gitlinks.filter((path) => !before.gitlinks.includes(path));

  return [
    ...changedOwn(before.own, after.own).map(
      (path) => `git: ${path} changed while the sandbox ran; review it before running git there`,
    ),
    ...entries.map(
      (entry) => `git: the sandbox ${known.has(entry.path) ? "changed" : "created"} ${entry.path}; ${REVIEW}`,
    ),
    ...gitlinks.map((path) => `git: the sandbox added the gitlink ${path} (a nested repository); ${REVIEW}`),
    ...(after.complete
      ? []
      : [`git: the scan for nested repositories stopped after ${after.budget} directories`]),
  ];
};
