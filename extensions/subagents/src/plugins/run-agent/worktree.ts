import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import type { Worktree } from "../../model/types.ts";

type WorktreeResult = { ok: true; worktree: Worktree } | { ok: false; error: string };

type GitResult = { ok: true; output: string } | { ok: false; error: string };

const REPOSITORY_OVERRIDES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

const gitEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !REPOSITORY_OVERRIDES.includes(key)));

const runGit = (cwd: string, args: string[]) =>
  new Promise<GitResult>((done) => {
    execFile("git", ["-C", cwd, ...args], { env: gitEnv() }, (error, stdout, stderr) => {
      if (error) {
        done({ ok: false, error: String(stderr).trim() || error.message });
        return;
      }

      done({ ok: true, output: String(stdout).trim() });
    });
  });

export const createWorktree = async (
  cwd: string,
  agentDir: string,
  agentId: string,
): Promise<WorktreeResult> => {
  const prefix = await runGit(cwd, ["rev-parse", "--show-prefix"]);

  if (!prefix.ok) {
    return { ok: false, error: `${cwd} is not inside a git repository: ${prefix.error}` };
  }

  const path = join(agentDir, "worktree");
  const branch = `pi-agents/${agentId}-${Date.now().toString(36)}`;
  const added = await runGit(cwd, ["worktree", "add", "-b", branch, path, "HEAD"]);

  if (!added.ok) {
    return { ok: false, error: `git worktree add failed: ${added.error}` };
  }

  return { ok: true, worktree: { path, branch, cwd: resolve(path, prefix.output) } };
};

export const removeWorktree = async (cwd: string, worktree: Worktree) => {
  const removed = await runGit(cwd, ["worktree", "remove", "--force", worktree.path]);

  if (!removed.ok) {
    return false;
  }

  const deleted = await runGit(cwd, ["branch", "-D", worktree.branch]);

  return deleted.ok;
};
