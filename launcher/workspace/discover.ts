import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type CommandRunner, errorMessage, LauncherError } from "../shared/index.ts";
import { inertGitOptions } from "./git-command.ts";
import { findGitRoot, gitLayoutAt } from "./git-layout.ts";
import type { Workspace } from "./types.ts";

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

const reportedByGit = async (cwd: string, runner: CommandRunner, emptyHooksDir: string) => {
  const result = await runner
    .run("git", [...inertGitOptions(emptyHooksDir), "rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd,
    })
    .catch(() => undefined);
  const [toplevel = "", commonDir = ""] = (result?.stdout ?? "").split("\n").map((line) => line.trim());

  if (result?.code !== 0 || toplevel === "" || commonDir === "") {
    return undefined;
  }

  return { repoRoot: await realPath(toplevel), gitCommonDir: await realPath(resolve(cwd, commonDir)) };
};

export const discoverWorkspace = async (
  cwd: string,
  runner: CommandRunner,
  emptyHooksDir: string,
): Promise<Workspace> => {
  const realCwd = await realPath(cwd);
  const root = await findGitRoot(realCwd);

  if (root === undefined) {
    return { cwd: realCwd, repoRoot: realCwd, isGitRepo: false };
  }

  const layout = await gitLayoutAt(root);
  const reported = await reportedByGit(realCwd, runner, emptyHooksDir);

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
    cwd: realCwd,
    repoRoot: root,
    gitDir: layout.gitDir,
    gitCommonDir: layout.gitCommonDir,
    isGitRepo: true,
  };
};
