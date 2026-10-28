import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureProjectDir, errorText } from "../../../../platform/shared/index.ts";
import type { Worktree, WorktreeCleanup } from "../model/agent-record.ts";

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

const ignoreWorktrees = (root: string) => {
  const file = join(root, ".gitignore");

  if (!existsSync(file)) {
    mkdirSync(root, { recursive: true });
    writeFileSync(file, "*\n");
  }
};

export const createWorktree = async (cwd: string, agentId: string): Promise<WorktreeResult> => {
  const head = await runGit(cwd, ["rev-parse", "HEAD", "--show-prefix"]);

  if (!head.ok) {
    return { ok: false, error: head.error };
  }

  const [base, prefix = ""] = head.output.split("\n");
  const root = join(cwd, ".pi", "worktrees");
  const name = `${agentId}-${Date.now().toString(36)}`;
  const path = join(root, name);
  const branch = `pi-agents/${name}`;

  try {
    ensureProjectDir(cwd);

    ignoreWorktrees(root);
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }

  const added = await runGit(cwd, ["worktree", "add", "-b", branch, path, base]);

  if (!added.ok) {
    return { ok: false, error: `git worktree add failed: ${added.error}` };
  }

  return { ok: true, worktree: { path, branch, base, cwd: resolve(path, prefix) } };
};

export const removeWorktree = async (worktree: Worktree): Promise<WorktreeCleanup> => {
  const repo = dirname(worktree.path);
  const removed = await runGit(repo, ["worktree", "remove", worktree.path]);

  if (!removed.ok) {
    return "kept";
  }

  const tip = await runGit(repo, ["rev-parse", worktree.branch]);

  if (!tip.ok || tip.output !== worktree.base) {
    return "branch kept";
  }

  const deleted = await runGit(repo, ["branch", "-D", worktree.branch]);

  return deleted.ok ? "removed" : "branch kept";
};
