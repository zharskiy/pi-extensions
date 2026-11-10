import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertGitIntegrity,
  discoverWorkspace,
  gitLaunchEndNotices,
  pinGitDirs,
  recordGitBaseline,
  unpinRecorded,
  workspaceFolder,
} from "../../workspace/index.ts";
import { git, gitRunner } from "../support/git.ts";
import { tempDir } from "../support/temp-dir.ts";

const discoverAt = async (
  cwd: string,
  ...rest: Parameters<typeof discoverWorkspace> extends [unknown, ...infer R] ? R : never
) => discoverWorkspace(await workspaceFolder(cwd), ...rest);

const runner = gitRunner;

const createRepo = async () => {
  const base = await realpath(await tempDir("git-integrity"));
  const repo = join(base, "repo");

  await mkdir(repo);

  await git(repo, ["init", "--quiet"]);

  await writeFile(join(repo, "README.md"), "hello\n");

  await git(repo, ["add", "README.md"]);

  await git(repo, ["commit", "--quiet", "-m", "init"]);

  const stateDir = join(base, "state");
  const workspace = await discoverAt(repo, runner, join(stateDir, "git", "no-hooks"));

  return { base, repo, workspace, context: { runner, stateDir } };
};

const idle = async () => false;

const alternatesNotice = (path: string) =>
  `git: ${path} is present, so host git also reads objects from the places it lists; check it if you did not set it up`;

describe("the worktree pointers in the common git dir", () => {
  it("refuses a worktree commondir repointed at another git dir", async () => {
    const { base, repo, workspace } = await createRepo();
    const other = join(base, "other");
    const commondir = join(repo, ".git", "worktrees", "linked", "commondir");

    await git(repo, ["worktree", "add", "--quiet", "-b", "feature", join(base, "linked")]);

    await mkdir(other);

    await expect(assertGitIntegrity(workspace)).resolves.toEqual([]);

    await writeFile(commondir, `${other}\n`);

    await expect(assertGitIntegrity(workspace)).rejects.toThrow(
      `git: ${commondir} points at ${other}, not ${join(repo, ".git")}`,
    );
  });

  it("refuses a worktree dir planted with a commondir that leads nowhere", async () => {
    const { repo, workspace } = await createRepo();
    const planted = join(repo, ".git", "worktrees", "planted");

    await mkdir(planted, { recursive: true });

    await writeFile(join(planted, "commondir"), "../../../missing\n");

    await expect(assertGitIntegrity(workspace)).rejects.toThrow(
      `git: ${join(planted, "commondir")} points at a missing directory, not ${join(repo, ".git")}`,
    );
  });
});

describe("the pin checks", () => {
  it("leaves an empty commondir for the pin write instead of filling it while checking", async () => {
    const { repo, workspace } = await createRepo();
    const commondir = join(repo, ".git", "commondir");
    const pinned: string[] = [];

    await writeFile(commondir, "");

    expect(await assertGitIntegrity(workspace)).toEqual([]);
    expect(await readFile(commondir, "utf8")).toBe("");

    await pinGitDirs(workspace, [], async (path) => {
      pinned.push(path);
    });

    expect(await readFile(commondir, "utf8")).toBe(".\n");
    expect(pinned).toEqual([commondir]);
  });
});

describe("the git notices after a session", () => {
  it("names only the alternates files that appeared during the session", async () => {
    const { repo, workspace, context } = await createRepo();
    const alternates = join(repo, ".git", "objects", "info", "alternates");
    const httpAlternates = join(repo, ".git", "objects", "info", "http-alternates");

    await writeFile(alternates, "/elsewhere/objects\n");

    await pinGitDirs(workspace, [], async () => undefined);

    await recordGitBaseline(workspace, context);

    await writeFile(httpAlternates, "https://example.com/objects\n");

    expect(await gitLaunchEndNotices(workspace, context)).toEqual([alternatesNotice(httpAlternates)]);
  });

  it("says so when it cannot remove the pin", async () => {
    const { repo, workspace, context } = await createRepo();
    const gitDir = join(repo, ".git");
    const pins: Array<{ path: string; gitCommonDir: string }> = [];

    await pinGitDirs(workspace, [], async (path) => {
      pins.push({ path, gitCommonDir: gitDir });
    });

    await chmod(gitDir, 0o555);

    const { notices, kept } = await unpinRecorded(context.stateDir, pins, idle).finally(() =>
      chmod(gitDir, 0o755),
    );

    expect(kept).toEqual([]);
    expect(notices).toEqual([
      `git: ${join(gitDir, "commondir")} could not be removed; remove it before running git in this repository`,
    ]);
  });

  it("says the scan for nested repositories stopped when the repository has too many directories", async () => {
    const { repo, workspace, context } = await createRepo();
    const narrow = { ...context, scanBudget: 5 };

    await Promise.all(
      Array.from({ length: 5 }, (_, index) => mkdir(join(repo, "wide", `d${index}`), { recursive: true })),
    );

    await pinGitDirs(workspace, [], async () => undefined);

    await recordGitBaseline(workspace, narrow);

    expect(await gitLaunchEndNotices(workspace, narrow)).toEqual([
      "git: the scan for nested repositories stopped after 5 directories",
    ]);
  });
});
