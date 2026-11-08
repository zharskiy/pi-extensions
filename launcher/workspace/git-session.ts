import {
  type CommandRunner,
  errorMessage,
  readJsonFile,
  repoHash,
  stateLayout,
  writeJsonFile,
} from "../shared/index.ts";
import { assertGitIntegrity, gitAlternatesNotices, unpinGitDirs, withGitPinLock } from "./git-integrity.ts";
import { type GitBaseline, nestedGitNotices, scanGitBaseline } from "./git-scan.ts";
import { gitRepos, type Workspace } from "./types.ts";

export interface GitSessionContext {
  runner: CommandRunner;
  stateDir: string;
}

interface SessionRecord {
  scan: GitBaseline;
  alternates: string[];
}

type PinsInUse = (gitCommonDir: string) => Promise<boolean>;

const pathsOf = (stateDir: string, repoRoot: string) => {
  const layout = stateLayout(stateDir);

  return { noHooks: layout.gitNoHooks, record: layout.gitBaseline(repoHash(repoRoot)) };
};

const alternatesOf = async (workspace: Workspace) => {
  const notices = await Promise.all(gitRepos(workspace).map(gitAlternatesNotices));

  return notices.flat();
};

export const recordGitBaseline = async (workspace: Workspace, context: GitSessionContext) => {
  const paths = pathsOf(context.stateDir, workspace.repoRoot);
  const [scan, alternates] = await Promise.all([
    scanGitBaseline(workspace, context.runner, paths.noHooks),
    alternatesOf(workspace),
  ]);

  await writeJsonFile(paths.record, { scan, alternates } satisfies SessionRecord);
};

export const gitLaunchNotices = async (workspace: Workspace) => {
  await Promise.all(gitRepos(workspace).map(assertGitIntegrity));

  return alternatesOf(workspace);
};

const scanNotices = async (workspace: Workspace, context: GitSessionContext, record: SessionRecord) => {
  const { noHooks } = pathsOf(context.stateDir, workspace.repoRoot);

  return nestedGitNotices(record.scan, await scanGitBaseline(workspace, context.runner, noHooks));
};

const commonDirRepos = (workspace: Workspace) => {
  const byCommonDir = new Map(
    gitRepos(workspace).flatMap((repo) =>
      repo.gitCommonDir === undefined ? [] : [[repo.gitCommonDir, repo] as const],
    ),
  );

  return [...byCommonDir.entries()];
};

const unpinned = async (workspace: Workspace, context: GitSessionContext, pinsInUse: PinsInUse) => {
  const notices = await Promise.all(
    commonDirRepos(workspace).map(([gitCommonDir, repo]) =>
      withGitPinLock(context.stateDir, repo, async () =>
        (await pinsInUse(gitCommonDir)) ? [] : unpinGitDirs(repo),
      ),
    ),
  );

  return notices.flat();
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

export const gitSessionEndNotices = async (
  workspace: Workspace,
  context: GitSessionContext,
  pinsInUse: PinsInUse,
) => {
  if (workspace.isGitRepo && workspace.gitCommonDir === undefined) {
    return [];
  }

  const released = await unpinned(workspace, context, pinsInUse);
  const broken = await brokenRepos(workspace);
  const record = await readJsonFile<SessionRecord>(
    pathsOf(context.stateDir, workspace.repoRoot).record,
  ).catch(() => undefined);
  const alternates = (await alternatesOf(workspace)).filter(
    (notice) => !(record?.alternates ?? []).includes(notice),
  );
  const scanned =
    record === undefined || broken.length > 0 ? [] : await scanNotices(workspace, context, record);

  return [...released, ...broken, ...alternates, ...scanned];
};
