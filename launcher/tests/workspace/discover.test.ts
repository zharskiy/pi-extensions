import { mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LauncherError } from "../../shared/index.ts";
import { discoverWorkspace, workspaceFolder } from "../../workspace/index.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { git, gitRunner } from "../support/git.ts";
import { tempDir } from "../support/temp-dir.ts";

const discoverAt = async (
  cwd: string,
  ...rest: Parameters<typeof discoverWorkspace> extends [unknown, ...infer R] ? R : never
) => discoverWorkspace(await workspaceFolder(cwd), ...rest);

const runner = gitRunner;

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

const temporaryFolder = async () => {
  const folder = await realpath(await tempDir("workspace"));

  return folder;
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

    expect(await discoverAt(repo, runner, NO_HOOKS)).toEqual({
      cwd: repo,
      repoRoot: repo,
      gitDir: join(repo, ".git"),
      gitCommonDir: join(repo, ".git"),
      isGitRepo: true,
      gitConfig: expect.objectContaining({ worktreeConfig: false }),
      overlays: [],
    });
  });

  it("keeps the cwd and finds the toplevel from a subfolder", async () => {
    const repo = await createRepo();
    const cwd = join(repo, "src", "deep");

    expect(await discoverAt(cwd, runner, NO_HOOKS)).toEqual({
      cwd,
      repoRoot: repo,
      gitDir: join(repo, ".git"),
      gitCommonDir: join(repo, ".git"),
      isGitRepo: true,
      gitConfig: expect.objectContaining({ worktreeConfig: false }),
      overlays: [],
    });
  });

  it("points a linked worktree at the main repository's common dir", async () => {
    const repo = await createRepo();
    const worktree = join(await temporaryFolder(), "linked");

    await git(repo, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

    expect(await discoverAt(worktree, runner, NO_HOOKS)).toEqual({
      cwd: worktree,
      repoRoot: worktree,
      gitDir: join(repo, ".git", "worktrees", "linked"),
      gitCommonDir: join(repo, ".git"),
      isGitRepo: true,
      gitConfig: expect.objectContaining({ worktreeConfig: false }),
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

    expect(await discoverAt(separate, runner, NO_HOOKS)).toMatchObject({
      repoRoot: separate,
      gitDir,
      gitCommonDir: gitDir,
    });
    expect(await discoverAt(join(superproject, "lib"), runner, NO_HOOKS)).toMatchObject({
      repoRoot: join(superproject, "lib"),
      gitDir: join(superproject, ".git", "modules", "lib"),
      gitCommonDir: join(superproject, ".git", "modules", "lib"),
    });
  });

  it("accepts the launcher's commondir pin, which git reads as the git dir itself", async () => {
    const repo = await createRepo();

    await writeFile(join(repo, ".git", "commondir"), ".\n");

    expect(await discoverAt(repo, runner, NO_HOOKS)).toMatchObject({
      gitDir: join(repo, ".git"),
      gitCommonDir: join(repo, ".git"),
    });
  });

  it("pins an empty commondir the engine left as a bind mountpoint in place, so host git works again", async () => {
    const repo = await createRepo();
    const commondir = join(repo, ".git", "commondir");

    await writeFile(commondir, "");

    const before = await stat(commondir);

    expect(await discoverAt(repo, runner, NO_HOOKS)).toMatchObject({
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

    await expect(discoverAt(repo, recorder, NO_HOOKS)).rejects.toThrow(
      `git: ${join(repo, ".git", "commondir")} was not written by git or the launcher`,
    );

    await writeFile(join(repo, ".git", "commondir"), `${join(other, ".git")}\n`);

    await expect(discoverAt(join(repo, "src"), recorder, NO_HOOKS)).rejects.toThrow(
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

    await expect(discoverAt(worktree, recorder, NO_HOOKS)).rejects.toThrow(
      `git: ${join(repo, ".git", "worktrees", "linked", "commondir")} points at ${join(other, ".git")}`,
    );
    expect(calls).toEqual([]);
  });

  it("refuses a .git that is a symbolic link", async () => {
    const repo = await createRepo();
    const folder = join(await temporaryFolder(), "linked");

    await mkdir(folder);

    await symlink(join(repo, ".git"), join(folder, ".git"));

    await expect(discoverAt(folder, runner, NO_HOOKS)).rejects.toThrow(
      `git: ${join(folder, ".git")} is a symbolic link`,
    );
  });

  it("refuses a .git file that points at the git dir of another checkout", async () => {
    const repo = await createRepo();
    const other = await createRepo();

    await writeFile(join(repo, "src", ".git"), `gitdir: ${join(other, ".git")}\n`);

    await expect(discoverAt(join(repo, "src"), runner, NO_HOOKS)).rejects.toThrow(
      `git: ${join(repo, "src", ".git")} points at ${join(other, ".git")}, the git dir of another checkout`,
    );
  });

  it("refuses a .git file that git does not open as a repository", async () => {
    const repo = await createRepo();
    const folder = await temporaryFolder();

    await writeFile(join(repo, "src", ".git"), `gitdir: ${folder}\n`);

    await expect(discoverAt(join(repo, "src"), runner, NO_HOOKS)).rejects.toThrow(
      `git: ${join(repo, "src", ".git")} leads to ${folder}, but git does not open it as a repository`,
    );
  });

  it("refuses when git chooses another git dir than the .git it finds", async () => {
    const repo = await createRepo();
    const other = await createRepo();
    const { runner: fake } = createFakeRunner(() => ({ stdout: `${repo}\n${join(other, ".git")}\n` }));

    await expect(discoverAt(repo, fake, NO_HOOKS)).rejects.toThrow(
      `git: ${join(repo, ".git")} leads to ${join(repo, ".git")}, but git reports`,
    );
  });

  it("finds the layout without git and without writing in lenient mode, falling back to the files when refused", async () => {
    const repo = await createRepo();
    const commondir = join(repo, ".git", "commondir");
    const { recorder, calls } = recording();

    await writeFile(commondir, "");

    expect(await discoverAt(repo, recorder, NO_HOOKS, { lenient: true })).toMatchObject({
      repoRoot: repo,
      gitDir: join(repo, ".git"),
      gitCommonDir: join(repo, ".git"),
    });
    expect(await readFile(commondir, "utf8")).toBe("");

    await writeFile(commondir, "../elsewhere\n");

    expect(await discoverAt(repo, recorder, NO_HOOKS, { lenient: true })).toMatchObject({
      repoRoot: repo,
      gitDir: join(repo, ".git"),
      gitCommonDir: join(repo, "elsewhere"),
    });
    expect(calls).toEqual([]);
  });

  it("says git is missing instead of blaming the repository", async () => {
    const repo = await createRepo();
    const { runner: missing } = createFakeRunner(() => undefined);

    await expect(discoverAt(repo, missing, NO_HOOKS)).rejects.toThrow("git: command not found");
  });

  it("refuses a repository whose configuration git cannot list, and lists nothing only without git", async () => {
    const repo = await createRepo();
    const answering = (config: () => Promise<{ code: number; stdout: string; stderr: string }>) => ({
      ...runner,
      run: (file: string, args: string[], options?: Parameters<typeof runner.run>[2]) =>
        args.includes("config") ? config() : runner.run(file, args, options),
    });
    const failing = answering(async () => ({ code: 128, stdout: "", stderr: "fatal: bad config line 3" }));
    const missing = answering(async () => {
      throw new LauncherError("git: command not found");
    });

    await expect(discoverAt(repo, failing, NO_HOOKS)).rejects.toThrow(
      `git: could not list the git configuration of ${repo}: fatal: bad config line 3`,
    );
    expect((await discoverAt(repo, missing, NO_HOOKS)).gitConfig).toEqual({
      files: [],
      includes: [],
      worktreeConfig: false,
    });
  });

  it("asks git once for the layout and once for the configuration of a repository", async () => {
    const repo = await createRepo();
    const { recorder, calls } = recording();

    await git(repo, ["config", "core.hooksPath", ".husky"]);

    const workspace = await discoverAt(repo, recorder, NO_HOOKS);

    expect(calls.map((call) => call.find((part) => part === "rev-parse" || part === "config"))).toEqual([
      "rev-parse",
      "config",
    ]);
    expect(workspace.gitConfig?.hooksPath).toBe(".husky");
  });

  it("uses the folder itself outside git", async () => {
    const folder = await temporaryFolder();

    expect(await discoverAt(folder, runner, NO_HOOKS)).toEqual({
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

    const workspace = await discoverAt(linked, fake, NO_HOOKS);

    expect(workspace.repoRoot).toBe(await realpath(linked));
  });

  it("reports a missing folder as a launcher error", async () => {
    const folder = await temporaryFolder();

    await expect(discoverAt(join(folder, "missing"), runner, NO_HOOKS)).rejects.toThrow("missing");
  });
});
