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
import type { Workspace } from "./types.ts";

export interface GitSessionContext {
  runner: CommandRunner;
  stateDir: string;
}

interface SessionRecord {
  scan: GitBaseline;
  alternates: string[];
}

const pathsOf = (stateDir: string, repoRoot: string) => {
  const layout = stateLayout(stateDir);

  return { noHooks: layout.gitNoHooks, record: layout.gitBaseline(repoHash(repoRoot)) };
};

export const recordGitBaseline = async (workspace: Workspace, context: GitSessionContext) => {
  const paths = pathsOf(context.stateDir, workspace.repoRoot);
  const [scan, alternates] = await Promise.all([
    scanGitBaseline(workspace, context.runner, paths.noHooks),
    gitAlternatesNotices(workspace),
  ]);

  await writeJsonFile(paths.record, { scan, alternates } satisfies SessionRecord);
};

export const gitLaunchNotices = async (workspace: Workspace) => {
  await assertGitIntegrity(workspace);

  return gitAlternatesNotices(workspace);
};

const scanNotices = async (workspace: Workspace, context: GitSessionContext, record: SessionRecord) => {
  const { noHooks } = pathsOf(context.stateDir, workspace.repoRoot);

  return nestedGitNotices(record.scan, await scanGitBaseline(workspace, context.runner, noHooks));
};

export const gitSessionEndNotices = async (
  workspace: Workspace,
  context: GitSessionContext,
  pinsInUse: () => Promise<boolean>,
) => {
  if (workspace.gitCommonDir === undefined) {
    return [];
  }

  const unpinned = await withGitPinLock(context.stateDir, workspace, async () =>
    (await pinsInUse()) ? [] : unpinGitDirs(workspace),
  );
  const broken = await assertGitIntegrity(workspace).then(
    () => [],
    (error: unknown) => [errorMessage(error)],
  );
  const record = await readJsonFile<SessionRecord>(
    pathsOf(context.stateDir, workspace.repoRoot).record,
  ).catch(() => undefined);
  const alternates = (await gitAlternatesNotices(workspace)).filter(
    (notice) => !(record?.alternates ?? []).includes(notice),
  );
  const scanned =
    record === undefined || broken.length > 0 ? [] : await scanNotices(workspace, context, record);

  return [...unpinned, ...broken, ...alternates, ...scanned];
};
