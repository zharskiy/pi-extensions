import type { Dirent } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { type CommandRunner, readRegularFile } from "../shared/index.ts";
import { inertGitOptions } from "./git-command.ts";
import { gitDirOf, gitRepos, type Workspace } from "./types.ts";
import { SCAN_BUDGET } from "./workspace-scan.ts";

export interface NestedGitEntry {
  path: string;
  kind: "directory" | "file" | "link" | "other";
  content?: string;
}

export interface GitBaseline {
  gitlinks: string[];
  nested: NestedGitEntry[];
  complete: boolean;
}

interface Walk {
  found: NestedGitEntry[];
  budget: number;
  complete: boolean;
}

const GITLINK_PREFIX = "160000 ";

const REVIEW = "review it before running host git tools in this repository";

const EMPTY: GitBaseline = { gitlinks: [], nested: [], complete: true };

const gitlinksOf = async (
  workspace: Workspace,
  gitCommonDir: string,
  runner: CommandRunner,
  emptyHooksDir: string,
) => {
  const args = [
    ...inertGitOptions(emptyHooksDir),
    `--git-dir=${gitDirOf(workspace, gitCommonDir)}`,
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

const contentOf = (path: string, kind: NestedGitEntry["kind"]) => {
  if (kind === "file") {
    return readRegularFile(path).then(
      (file) => file.data.toString("utf8"),
      () => "",
    );
  }

  return kind === "link" ? readlink(path).catch(() => "") : Promise.resolve(undefined);
};

const describe = async (path: string, entry: Dirent): Promise<NestedGitEntry> => {
  const kind = kindOf(entry);
  const content = await contentOf(path, kind);

  return content === undefined ? { path, kind } : { path, kind, content };
};

const listed = async (dir: string) => ({
  dir,
  entries: await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []),
});

const walkLevel = async (dirs: string[], skipped: Set<string>, walk: Walk): Promise<Walk> => {
  if (dirs.length === 0) {
    return walk;
  }

  if (walk.budget <= 0) {
    return { ...walk, complete: false };
  }

  const taken = dirs.slice(0, walk.budget);
  const levels = await Promise.all(taken.map(listed));
  const gitEntries = levels.flatMap(({ dir, entries }) =>
    entries
      .filter((entry) => entry.name === ".git" && !skipped.has(join(dir, entry.name)))
      .map((entry) => ({ path: join(dir, entry.name), entry })),
  );
  const found = await Promise.all(gitEntries.map(({ path, entry }) => describe(path, entry)));
  const next = levels.flatMap(({ dir, entries }) =>
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== ".git")
      .map((entry) => join(dir, entry.name))
      .filter((path) => !skipped.has(path)),
  );

  return walkLevel(next, skipped, {
    found: [...walk.found, ...found],
    budget: walk.budget - taken.length,
    complete: walk.complete && taken.length === dirs.length,
  });
};

const gitDirsOf = (repo: Workspace) =>
  [join(repo.repoRoot, ".git"), repo.gitCommonDir, repo.gitDir].filter((path) => path !== undefined);

const repoGitlinks = (repo: Workspace, runner: CommandRunner, emptyHooksDir: string) =>
  repo.gitCommonDir === undefined
    ? Promise.resolve([])
    : gitlinksOf(repo, repo.gitCommonDir, runner, emptyHooksDir);

export const scanGitBaseline = async (
  workspace: Workspace,
  runner: CommandRunner,
  emptyHooksDir: string,
): Promise<GitBaseline> => {
  if (workspace.isGitRepo && workspace.gitCommonDir === undefined) {
    return EMPTY;
  }

  const repos = gitRepos(workspace);
  const skipped = new Set(repos.flatMap(gitDirsOf));
  const [walk, gitlinks] = await Promise.all([
    walkLevel([workspace.repoRoot], skipped, { found: [], budget: SCAN_BUDGET, complete: true }),
    Promise.all(repos.map((repo) => repoGitlinks(repo, runner, emptyHooksDir))),
  ]);

  return {
    gitlinks: gitlinks.flat().sort(),
    nested: walk.found,
    complete: walk.complete,
  };
};

const changed = (before: NestedGitEntry | undefined, after: NestedGitEntry) =>
  before === undefined || before.kind !== after.kind || before.content !== after.content;

export const nestedGitNotices = (before: GitBaseline, after: GitBaseline) => {
  const known = new Map(before.nested.map((entry) => [entry.path, entry]));
  const entries = after.nested.filter((entry) => changed(known.get(entry.path), entry));
  const gitlinks = after.gitlinks.filter((path) => !before.gitlinks.includes(path));

  return [
    ...entries.map(
      (entry) => `git: the sandbox ${known.has(entry.path) ? "changed" : "created"} ${entry.path}; ${REVIEW}`,
    ),
    ...gitlinks.map((path) => `git: the sandbox added the gitlink ${path} (a nested repository); ${REVIEW}`),
    ...(after.complete
      ? []
      : [`git: the scan for nested repositories stopped after ${SCAN_BUDGET} directories`]),
  ];
};
