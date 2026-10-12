import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import type { Worktree } from "../../model/types.ts";

export const WORKTREE_DIR = "worktree";

const BRANCH_PREFIX = "pi-agents/";

type WorktreeResult = { ok: true; worktree: Worktree } | { ok: false; error: string };

export type Worktrees = {
  create(cwd: string, agentDir: string, branch: string): Promise<WorktreeResult>;
  remove(cwd: string, worktree: Worktree): Promise<boolean>;
};

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

export const worktreeBranch = (agentId: string, token: string) => `${BRANCH_PREFIX}${agentId}-${token}`;

export const createWorktree = async (
  cwd: string,
  agentDir: string,
  branch: string,
): Promise<WorktreeResult> => {
  const prefix = await runGit(cwd, ["rev-parse", "--show-prefix"]);

  if (!prefix.ok) {
    return { ok: false, error: `${cwd} is not inside a git repository: ${prefix.error}` };
  }

  const path = join(agentDir, WORKTREE_DIR);
  const added = await runGit(cwd, ["worktree", "add", "-b", branch, path, "HEAD"]);

  if (!added.ok) {
    return { ok: false, error: `git worktree add failed: ${added.error}` };
  }

  return { ok: true, worktree: { path, branch, cwd: resolve(path, prefix.output) } };
};

const removeWorktree = async (cwd: string, worktree: Worktree) => {
  const removed = await runGit(cwd, ["worktree", "remove", "--force", worktree.path]);

  if (!removed.ok) {
    return false;
  }

  const deleted = await runGit(cwd, ["branch", "-D", worktree.branch]);

  return deleted.ok;
};

export const gitWorktrees: Worktrees = { create: createWorktree, remove: removeWorktree };
