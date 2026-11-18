import { rm } from "node:fs/promises";
import {
  type CommandRunner,
  errorMessage,
  readJsonFile,
  repoHash,
  stateLayout,
  writeJsonFile,
} from "../../shared/index.ts";
import { gitRepos, type Workspace } from "../types.ts";
import { assertGitIntegrity, gitAlternatesNotices } from "./integrity.ts";
import { type GitBaseline, nestedGitNotices, scanGitBaseline } from "./scan.ts";

export interface GitLaunchContext {
  runner: CommandRunner;
  stateDir: string;
  scanBudget?: number;
  volumePaths?: string[];
}

interface BaselineRecord {
  scan: GitBaseline;
  alternates: string[];
}

const pathsOf = (stateDir: string, repoRoot: string) => {
  const layout = stateLayout(stateDir);

  return { noHooks: layout.emptyDir, record: layout.repo(repoHash(repoRoot)).gitBaseline };
};

const alternatesOf = async (workspace: Workspace) => {
  const notices = await Promise.all(gitRepos(workspace).map(gitAlternatesNotices));

  return notices.flat();
};

const readRecord = async (path: string) => {
  const record = await readJsonFile<BaselineRecord>(path).catch(() => undefined);

  return Array.isArray(record?.scan?.own) ? record : undefined;
};

const changedSince = (record: BaselineRecord, scan: GitBaseline, alternates: string[]) => [
  ...alternates.filter((notice) => !record.alternates.includes(notice)),
  ...nestedGitNotices(record.scan, scan),
];

const PENDING = "git: the check after the last sandbox session did not run; it reports now:";

export const recordGitBaseline = async (
  workspace: Workspace,
  context: GitLaunchContext,
  othersLive = false,
) => {
  const paths = pathsOf(context.stateDir, workspace.repoRoot);
  const previous = await readRecord(paths.record);

  if (othersLive && previous !== undefined) {
    return [];
  }

  const [scan, alternates] = await Promise.all([
    scanGitBaseline(workspace, context.runner, paths.noHooks, context.scanBudget, context.volumePaths),
    alternatesOf(workspace),
  ]);
  const pending = previous === undefined || othersLive ? [] : changedSince(previous, scan, alternates);

  await writeJsonFile(paths.record, { scan, alternates } satisfies BaselineRecord);

  return pending.length === 0 ? [] : [PENDING, ...pending];
};

export const gitLaunchNotices = async (workspace: Workspace) => {
  await Promise.all(gitRepos(workspace).map(assertGitIntegrity));

  return alternatesOf(workspace);
};

const brokenRepos = async (workspace: Workspace) => {
  const notices = await Promise.all(
    gitRepos(workspace).map((repo) =>
      assertGitIntegrity(repo).then(
        () => [],
        (error: unknown) => [errorMessage(error)],
      ),
    ),
  );

  return notices.flat();
};

export const gitLaunchEndNotices = async (workspace: Workspace, context: GitLaunchContext) => {
  if (workspace.isGitRepo && workspace.gitCommonDir === undefined) {
    return [];
  }

  const paths = pathsOf(context.stateDir, workspace.repoRoot);
  const [broken, record, alternates] = await Promise.all([
    brokenRepos(workspace),
    readRecord(paths.record),
    alternatesOf(workspace),
  ]);

  if (record === undefined || broken.length > 0) {
    return [...broken, ...alternates.filter((notice) => !(record?.alternates ?? []).includes(notice))];
  }

  const scan = await scanGitBaseline(
    workspace,
    context.runner,
    paths.noHooks,
    context.scanBudget,
    context.volumePaths,
  );

  await rm(paths.record, { force: true });

  return changedSince(record, scan, alternates);
};
