import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessRunner } from "../../shared/index.ts";
import { discoverWorkspace } from "../../workspace/index.ts";
import { createFakeRunner } from "../support/fake-runner.ts";

const runner = createProcessRunner();

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const temporaryFolder = async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-workspace-")));

  created.push(folder);

  return folder;
};

const git = async (cwd: string, args: string[]) => {
  const result = await runner.run(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    {
      cwd,
    },
  );

  expect(result.code, result.stderr).toBe(0);
};

const createRepo = async () => {
  const repo = join(await temporaryFolder(), "repo");

  await mkdir(join(repo, "src", "deep"), { recursive: true });

  await git(repo, ["init", "--quiet"]);
  await git(repo, ["commit", "--quiet", "--allow-empty", "-m", "init"]);

  return repo;
};

describe("discoverWorkspace", () => {
  it("finds the toplevel and the .git common dir from the repository root", async () => {
    const repo = await createRepo();

    expect(await discoverWorkspace(repo, runner)).toEqual({
      cwd: repo,
      repoRoot: repo,
      gitCommonDir: join(repo, ".git"),
      isGitRepo: true,
    });
  });

  it("keeps the cwd and finds the toplevel from a subfolder", async () => {
    const repo = await createRepo();
    const cwd = join(repo, "src", "deep");

    expect(await discoverWorkspace(cwd, runner)).toEqual({
      cwd,
      repoRoot: repo,
      gitCommonDir: join(repo, ".git"),
      isGitRepo: true,
    });
  });

  it("points a linked worktree at the main repository's common dir", async () => {
    const repo = await createRepo();
    const worktree = join(await temporaryFolder(), "linked");

    await git(repo, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

    expect(await discoverWorkspace(worktree, runner)).toEqual({
      cwd: worktree,
      repoRoot: worktree,
      gitCommonDir: join(repo, ".git"),
      isGitRepo: true,
    });
  });

  it("uses the folder itself outside git", async () => {
    const folder = await temporaryFolder();

    expect(await discoverWorkspace(folder, runner)).toEqual({
      cwd: folder,
      repoRoot: folder,
      isGitRepo: false,
    });
  });

  it("resolves symlinked paths to their real location", async () => {
    const { runner: fake } = createFakeRunner(() => ({ code: 128, stderr: "fatal: not a git repository" }));
    const folder = await temporaryFolder();
    const linked = join(tmpdir(), folder.split("/").at(-1) ?? "");

    const workspace = await discoverWorkspace(linked, fake);

    expect(workspace.repoRoot).toBe(await realpath(linked));
  });

  it("reports a missing folder as a launcher error", async () => {
    const folder = await temporaryFolder();

    await expect(discoverWorkspace(join(folder, "missing"), runner)).rejects.toThrow("missing");
  });
});
