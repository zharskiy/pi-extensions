import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessRunner } from "../../shared/index.ts";
import { discoverWorkspace } from "../../workspace/index.ts";
import { createFakeRunner } from "../support/fake-runner.ts";

const runner = createProcessRunner();

const NO_HOOKS = join(tmpdir(), "pi-sandbox-no-hooks");

const recording = () => {
  const calls: string[][] = [];
  const recorder = {
    ...runner,
    run: (file: string, args: string[], options?: Parameters<typeof runner.run>[2]) => {
      calls.push([file, ...args]);

      return runner.run(file, args, options);
    },
  };

  return { recorder, calls };
};

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
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
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

    expect(await discoverWorkspace(repo, runner, NO_HOOKS)).toEqual({
      cwd: repo,
      repoRoot: repo,
      gitDir: join(repo, ".git"),
      gitCommonDir: join(repo, ".git"),
      isGitRepo: true,
      overlays: [],
    });
  });

  it("keeps the cwd and finds the toplevel from a subfolder", async () => {
    const repo = await createRepo();
    const cwd = join(repo, "src", "deep");

    expect(await discoverWorkspace(cwd, runner, NO_HOOKS)).toEqual({
      cwd,
      repoRoot: repo,
      gitDir: join(repo, ".git"),
      gitCommonDir: join(repo, ".git"),
      isGitRepo: true,
      overlays: [],
    });
  });

  it("points a linked worktree at the main repository's common dir", async () => {
    const repo = await createRepo();
    const worktree = join(await temporaryFolder(), "linked");

    await git(repo, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

    expect(await discoverWorkspace(worktree, runner, NO_HOOKS)).toEqual({
      cwd: worktree,
      repoRoot: worktree,
      gitDir: join(repo, ".git", "worktrees", "linked"),
      gitCommonDir: join(repo, ".git"),
      isGitRepo: true,
      overlays: [],
    });
  });

  it("accepts a separate git dir and a submodule checked out as its own repository", async () => {
    const base = await temporaryFolder();
    const separate = join(base, "separate");
    const gitDir = join(base, "separate.git");

    await git(base, ["init", "--quiet", `--separate-git-dir=${gitDir}`, separate]);

    const library = await createRepo();
    const superproject = await createRepo();

    await git(superproject, ["submodule", "add", "--quiet", library, "lib"]);

    expect(await discoverWorkspace(separate, runner, NO_HOOKS)).toMatchObject({
      repoRoot: separate,
      gitDir,
      gitCommonDir: gitDir,
    });
    expect(await discoverWorkspace(join(superproject, "lib"), runner, NO_HOOKS)).toMatchObject({
      repoRoot: join(superproject, "lib"),
      gitDir: join(superproject, ".git", "modules", "lib"),
      gitCommonDir: join(superproject, ".git", "modules", "lib"),
    });
  });

  it("accepts the launcher's commondir pin, which git reads as the git dir itself", async () => {
    const repo = await createRepo();

    await writeFile(join(repo, ".git", "commondir"), ".\n");

    expect(await discoverWorkspace(repo, runner, NO_HOOKS)).toMatchObject({
      gitDir: join(repo, ".git"),
      gitCommonDir: join(repo, ".git"),
    });
  });

  it("pins an empty commondir the engine left as a bind mountpoint in place, so host git works again", async () => {
    const repo = await createRepo();
    const commondir = join(repo, ".git", "commondir");

    await writeFile(commondir, "");

    const before = await stat(commondir);

    expect(await discoverWorkspace(repo, runner, NO_HOOKS)).toMatchObject({
      gitDir: join(repo, ".git"),
      gitCommonDir: join(repo, ".git"),
    });
    expect(await readFile(commondir, "utf8")).toBe(".\n");
    expect((await stat(commondir)).ino).toBe(before.ino);

    await git(repo, ["status"]);
  });

  it("refuses a commondir the sandbox planted, naming the file, before running git", async () => {
    const repo = await createRepo();
    const other = await createRepo();
    const { recorder, calls } = recording();

    await writeFile(join(repo, ".git", "commondir"), "../.x\n");

    await expect(discoverWorkspace(repo, recorder, NO_HOOKS)).rejects.toThrow(
      `git: ${join(repo, ".git", "commondir")} was not written by git or the launcher`,
    );

    await writeFile(join(repo, ".git", "commondir"), `${join(other, ".git")}\n`);

    await expect(discoverWorkspace(join(repo, "src"), recorder, NO_HOOKS)).rejects.toThrow(
      "was not written by git or the launcher",
    );
    expect(calls).toEqual([]);
  });

  it("refuses a linked worktree whose commondir points at another repository", async () => {
    const repo = await createRepo();
    const other = await createRepo();
    const worktree = join(await temporaryFolder(), "linked");
    const { recorder, calls } = recording();

    await git(repo, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

    await writeFile(join(repo, ".git", "worktrees", "linked", "commondir"), `${join(other, ".git")}\n`);

    await expect(discoverWorkspace(worktree, recorder, NO_HOOKS)).rejects.toThrow(
      `git: ${join(repo, ".git", "worktrees", "linked", "commondir")} points at ${join(other, ".git")}`,
    );
    expect(calls).toEqual([]);
  });

  it("refuses a .git that is a symbolic link", async () => {
    const repo = await createRepo();
    const folder = join(await temporaryFolder(), "linked");

    await mkdir(folder);

    await symlink(join(repo, ".git"), join(folder, ".git"));

    await expect(discoverWorkspace(folder, runner, NO_HOOKS)).rejects.toThrow(
      `git: ${join(folder, ".git")} is a symbolic link`,
    );
  });

  it("refuses a .git file that points at the git dir of another checkout", async () => {
    const repo = await createRepo();
    const other = await createRepo();

    await writeFile(join(repo, "src", ".git"), `gitdir: ${join(other, ".git")}\n`);

    await expect(discoverWorkspace(join(repo, "src"), runner, NO_HOOKS)).rejects.toThrow(
      `git: ${join(repo, "src", ".git")} points at ${join(other, ".git")}, the git dir of another checkout`,
    );
  });

  it("refuses a .git file that git does not open as a repository", async () => {
    const repo = await createRepo();
    const folder = await temporaryFolder();

    await writeFile(join(repo, "src", ".git"), `gitdir: ${folder}\n`);

    await expect(discoverWorkspace(join(repo, "src"), runner, NO_HOOKS)).rejects.toThrow(
      `git: ${join(repo, "src", ".git")} leads to ${folder}, but git does not open it as a repository`,
    );
  });

  it("refuses when git chooses another git dir than the .git it finds", async () => {
    const repo = await createRepo();
    const other = await createRepo();
    const { runner: fake } = createFakeRunner(() => ({ stdout: `${repo}\n${join(other, ".git")}\n` }));

    await expect(discoverWorkspace(repo, fake, NO_HOOKS)).rejects.toThrow(
      `git: ${join(repo, ".git")} leads to ${join(repo, ".git")}, but git reports`,
    );
  });

  it("uses the folder itself outside git", async () => {
    const folder = await temporaryFolder();

    expect(await discoverWorkspace(folder, runner, NO_HOOKS)).toEqual({
      cwd: folder,
      repoRoot: folder,
      isGitRepo: false,
      nested: [],
      overlays: [],
    });
  });

  it("resolves symlinked paths to their real location", async () => {
    const { runner: fake } = createFakeRunner(() => undefined);
    const folder = await temporaryFolder();
    const linked = join(tmpdir(), folder.split("/").at(-1) ?? "");

    const workspace = await discoverWorkspace(linked, fake, NO_HOOKS);

    expect(workspace.repoRoot).toBe(await realpath(linked));
  });

  it("reports a missing folder as a launcher error", async () => {
    const folder = await temporaryFolder();

    await expect(discoverWorkspace(join(folder, "missing"), runner, NO_HOOKS)).rejects.toThrow("missing");
  });
});
