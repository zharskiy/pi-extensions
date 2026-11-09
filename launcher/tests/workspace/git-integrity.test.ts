import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessRunner } from "../../shared/index.ts";
import {
  assertGitIntegrity,
  discoverWorkspace,
  gitLaunchEndNotices,
  pinGitDirs,
  recordGitBaseline,
  unpinRecorded,
} from "../../workspace/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const runner = createProcessRunner();

const git = async (cwd: string, args: string[]) => {
  const result = await runner.run(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd },
  );

  expect(result.code, result.stderr).toBe(0);
};

const createRepo = async () => {
  const base = await realpath(await tempDir("git-integrity"));
  const repo = join(base, "repo");

  await mkdir(repo);

  await git(repo, ["init", "--quiet"]);

  await writeFile(join(repo, "README.md"), "hello\n");

  await git(repo, ["add", "README.md"]);

  await git(repo, ["commit", "--quiet", "-m", "init"]);

  const stateDir = join(base, "state");
  const workspace = await discoverWorkspace(repo, runner, join(stateDir, "git", "no-hooks"));

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

describe("the git notices after a session", () => {
  it("names only the alternates files that appeared during the session", async () => {
    const { repo, workspace, context } = await createRepo();
    const alternates = join(repo, ".git", "objects", "info", "alternates");
    const httpAlternates = join(repo, ".git", "objects", "info", "http-alternates");

    await writeFile(alternates, "/elsewhere/objects\n");

    await pinGitDirs(workspace, []);

    await recordGitBaseline(workspace, context);

    await writeFile(httpAlternates, "https://example.com/objects\n");

    expect(await gitLaunchEndNotices(workspace, context)).toEqual([alternatesNotice(httpAlternates)]);
  });

  it("says so when it cannot remove the pin", async () => {
    const { repo, workspace, context } = await createRepo();
    const gitDir = join(repo, ".git");
    const pins = (await pinGitDirs(workspace, [])).map((path) => ({ path, gitCommonDir: gitDir }));

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
    const wide = join(repo, "wide");

    await mkdir(wide);

    await Promise.all(Array.from({ length: 50_000 }, (_, index) => mkdir(join(wide, `d${index}`))));

    await pinGitDirs(workspace, []);

    await recordGitBaseline(workspace, context);

    expect(await gitLaunchEndNotices(workspace, context)).toEqual([
      "git: the scan for nested repositories stopped after 50000 directories",
    ]);
  }, 60_000);
});
