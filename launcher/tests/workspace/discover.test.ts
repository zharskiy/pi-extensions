import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverWorkspace, workspaceFolder } from "../../workspace/index.ts";
import { git } from "../support/git.ts";
import { tempDir } from "../support/temp-dir.ts";

const discoverAt = async (cwd: string) => discoverWorkspace(await workspaceFolder(cwd));

const temporaryFolder = async () => realpath(await tempDir("workspace"));

const createRepo = async (path?: string) => {
  const repo = path ?? join(await temporaryFolder(), "repo");

  await mkdir(join(repo, "src", "deep"), { recursive: true });

  await git(repo, ["init", "--quiet"]);

  await git(repo, ["commit", "--quiet", "--allow-empty", "-m", "init"]);

  return repo;
};

describe("discoverWorkspace", () => {
  it("finds the toplevel and the .git common dir from the repository root, and nothing more", async () => {
    const repo = await createRepo();

    await writeFile(join(repo, "package-lock.json"), "{}");

    expect(await discoverAt(repo)).toEqual({
      cwd: repo,
      repoRoot: repo,
      gitDir: join(repo, ".git"),
      gitCommonDir: join(repo, ".git"),
      isGitRepo: true,
    });
  });

  it("keeps the cwd and finds the toplevel from a subfolder", async () => {
    const repo = await createRepo();
    const cwd = join(repo, "src", "deep");

    expect(await discoverAt(cwd)).toMatchObject({ cwd, repoRoot: repo, gitCommonDir: join(repo, ".git") });
  });

  it("points a linked worktree at the main repository's common dir", async () => {
    const repo = await createRepo();
    const worktree = join(await temporaryFolder(), "linked");

    await git(repo, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

    expect(await discoverAt(worktree)).toMatchObject({
      cwd: worktree,
      repoRoot: worktree,
      gitDir: join(repo, ".git", "worktrees", "linked"),
      gitCommonDir: join(repo, ".git"),
    });
  });

  it("finds a separate git dir and a submodule's git dir", async () => {
    const base = await temporaryFolder();
    const separate = join(base, "separate");
    const gitDir = join(base, "separate.git");

    await git(base, ["init", "--quiet", `--separate-git-dir=${gitDir}`, separate]);

    const library = await createRepo();
    const superproject = await createRepo();

    await git(superproject, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      library,
      "lib",
    ]);

    expect(await discoverAt(separate)).toMatchObject({ repoRoot: separate, gitDir, gitCommonDir: gitDir });
    expect(await discoverAt(join(superproject, "lib"))).toMatchObject({
      repoRoot: join(superproject, "lib"),
      gitDir: join(superproject, ".git", "modules", "lib"),
      gitCommonDir: join(superproject, ".git", "modules", "lib"),
    });
  });

  it("reads the commondir file without running git and without writing", async () => {
    const repo = await createRepo();
    const commondir = join(repo, ".git", "commondir");

    await writeFile(commondir, "");

    expect(await discoverAt(repo)).toMatchObject({ gitCommonDir: join(repo, ".git") });
    expect(await readFile(commondir, "utf8")).toBe("");

    await writeFile(commondir, "../elsewhere\n");

    expect(await discoverAt(repo)).toMatchObject({ gitCommonDir: join(repo, "elsewhere") });
  });

  it("resolves a relative commondir from the real path of a linked git dir, as git does", async () => {
    const base = await temporaryFolder();
    const gitDir = join(base, "main", ".git", "worktrees", "wt");
    const link = join(base, "links", "deep", "gitdir");
    const worktree = join(base, "wt");

    await mkdir(gitDir, { recursive: true });
    await mkdir(join(base, "links", "deep"), { recursive: true });
    await mkdir(worktree);

    await writeFile(join(gitDir, "commondir"), "../..\n");

    await symlink(gitDir, link);

    await writeFile(join(worktree, ".git"), `gitdir: ${link}\n`);

    expect(await discoverAt(worktree)).toMatchObject({ gitDir, gitCommonDir: join(base, "main", ".git") });
  });

  it("finds a repository whose path holds a newline or ends in a space", async () => {
    const base = await temporaryFolder();

    await Promise.all(["a\nb", "proj "].map((name) => git(base, ["init", "--quiet", name])));

    await Promise.all(
      ["a\nb", "proj "].map(async (name) =>
        expect(await discoverAt(join(base, name))).toMatchObject({
          repoRoot: join(base, name),
          gitCommonDir: join(base, name, ".git"),
        }),
      ),
    );
  });

  it("uses the folder itself outside git", async () => {
    const folder = await temporaryFolder();

    expect(await discoverAt(folder)).toEqual({
      cwd: folder,
      repoRoot: folder,
      isGitRepo: false,
    });
  });

  it("resolves symlinked paths to their real location", async () => {
    const folder = await temporaryFolder();
    const linked = join(await temporaryFolder(), "link");

    await symlink(folder, linked);

    expect((await discoverAt(linked)).repoRoot).toBe(folder);
  });

  it("reports a missing folder as a launcher error", async () => {
    const folder = await temporaryFolder();

    await expect(discoverAt(join(folder, "missing"))).rejects.toThrow("missing");
  });
});
