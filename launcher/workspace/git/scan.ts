import type { Dirent } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { type CommandRunner, isWithin, readRegularFile } from "../../shared/index.ts";
import { gitDirsOf, gitRepos, type Workspace } from "../types.ts";
import { walkLevels } from "../walk.ts";
import { scanBudgetOf } from "../workspace-scan.ts";
import { inertGitOptions } from "./command.ts";
import { hasGitDirShape, isGitName } from "./layout.ts";

export interface NestedGitEntry {
  path: string;
  kind: "directory" | "file" | "link" | "other";
  content?: string;
}

export interface GitBaseline {
  gitlinks: string[];
  nested: NestedGitEntry[];
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

interface Level {
  found: NestedGitEntry[];
  next: string[];
}

const listedIn =
  (skipped: Set<string>) =>
  async (dir: string): Promise<Level> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);

    if (hasGitDirShape(entries.map((entry) => entry.name))) {
      return { found: [{ path: dir, kind: "directory" }], next: [] };
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
  const budget = scanBudgetOf(scanBudget);

  if (workspace.isGitRepo && workspace.gitCommonDir === undefined) {
    return { gitlinks: [], nested: [], complete: true, budget };
  }

  const repos = gitRepos(workspace);
  const volumes = volumePaths.filter(
    (path) => path !== workspace.repoRoot && isWithin(path, workspace.repoRoot),
  );
  const skipped = new Set([...repos.flatMap(gitPathsOf), ...volumes, ...(workspace.bareDirs ?? [])]);
  const [walk, gitlinks] = await Promise.all([
    walkLevels([workspace.repoRoot], budget, [] as NestedGitEntry[], {
      list: listedIn(skipped),
      children: (level) => level.next,
      fold: (found, levels) => [...found, ...levels.flatMap((level) => level.found)],
    }),
    Promise.all(repos.map((repo) => repoGitlinks(repo, runner, emptyHooksDir))),
  ]);

  return {
    gitlinks: gitlinks.flat().sort(),
    nested: walk.state,
    complete: walk.complete,
    budget,
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
      : [`git: the scan for nested repositories stopped after ${after.budget} directories`]),
  ];
};
