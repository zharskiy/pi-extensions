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

export const recordGitBaseline = async (workspace: Workspace, context: GitLaunchContext) => {
  const paths = pathsOf(context.stateDir, workspace.repoRoot);
  const [scan, alternates] = await Promise.all([
    scanGitBaseline(workspace, context.runner, paths.noHooks, context.scanBudget, context.volumePaths),
    alternatesOf(workspace),
  ]);

  await writeJsonFile(paths.record, { scan, alternates } satisfies BaselineRecord);
};

export const gitLaunchNotices = async (workspace: Workspace) => {
  await Promise.all(gitRepos(workspace).map(assertGitIntegrity));

  return alternatesOf(workspace);
};

const scanNotices = async (workspace: Workspace, context: GitLaunchContext, record: BaselineRecord) => {
  const { noHooks } = pathsOf(context.stateDir, workspace.repoRoot);

  return nestedGitNotices(
    record.scan,
    await scanGitBaseline(workspace, context.runner, noHooks, context.scanBudget, context.volumePaths),
  );
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

  const broken = await brokenRepos(workspace);
  const record = await readJsonFile<BaselineRecord>(
    pathsOf(context.stateDir, workspace.repoRoot).record,
  ).catch(() => undefined);
  const alternates = (await alternatesOf(workspace)).filter(
    (notice) => !(record?.alternates ?? []).includes(notice),
  );
  const scanned =
    record === undefined || broken.length > 0 ? [] : await scanNotices(workspace, context, record);

  return [...broken, ...alternates, ...scanned];
};
