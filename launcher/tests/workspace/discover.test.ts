import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverWorkspace, workspaceFolder } from "../../workspace/index.ts";
import { git } from "../support/git.ts";
import { tempDir } from "../support/temp-dir.ts";

const discoverAt = async (cwd: string, options?: Parameters<typeof discoverWorkspace>[1]) =>
  discoverWorkspace(await workspaceFolder(cwd), options);

const temporaryFolder = async () => realpath(await tempDir("workspace"));

const createRepo = async (path?: string) => {
  const repo = path ?? join(await temporaryFolder(), "repo");

  await mkdir(join(repo, "src", "deep"), { recursive: true });

  await git(repo, ["init", "--quiet"]);

  await git(repo, ["commit", "--quiet", "--allow-empty", "-m", "init"]);

  return repo;
};

const markRepo = (path: string) => mkdir(join(path, ".git"), { recursive: true });

describe("discoverWorkspace", () => {
  it("finds the toplevel and the .git common dir from the repository root", async () => {
    const repo = await createRepo();

    expect(await discoverAt(repo)).toEqual({
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

  it("uses the folder itself outside git and searches nothing in it", async () => {
    const folder = await temporaryFolder();

    await mkdir(join(folder, "app"));

    await writeFile(join(folder, "app", "package-lock.json"), "{}");

    expect(await discoverAt(folder)).toEqual({
      cwd: folder,
      repoRoot: folder,
      isGitRepo: false,
      overlays: [],
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

describe("the overlay search", () => {
  it("overlays the build output each marker names, skipping a marker folder whose output is a file", async () => {
    const repo = await createRepo();
    const folders = ["api", "cli", "app", "plain"].map((name) => join(repo, name));

    await Promise.all(folders.map((dir) => mkdir(dir)));

    await Promise.all([
      writeFile(join(repo, "api", "uv.lock"), ""),
      writeFile(join(repo, "api", "poetry.lock"), ""),
      writeFile(join(repo, "cli", "Cargo.lock"), ""),
      writeFile(join(repo, "app", "settings.gradle.kts"), ""),
      writeFile(join(repo, "plain", "Pipfile.lock"), ""),
      writeFile(join(repo, "plain", ".venv"), ""),
      writeFile(join(repo, "settings.gradle"), ""),
    ]);

    expect((await discoverAt(repo)).overlays).toEqual([
      join(repo, ".gradle"),
      join(repo, "api", ".venv"),
      join(repo, "app", ".gradle"),
      join(repo, "cli", "target"),
    ]);
  });

  it("overlays only the launch repository, not its siblings in the workspace root", async () => {
    const root = await temporaryFolder();
    const repo = await createRepo(join(root, "repo"));
    const sibling = await createRepo(join(root, "sibling"));

    await Promise.all([
      writeFile(join(repo, "package-lock.json"), "{}"),
      writeFile(join(sibling, "package-lock.json"), "{}"),
      writeFile(join(root, "package-lock.json"), "{}"),
    ]);

    expect((await discoverAt(join(repo, "src"))).overlays).toEqual([join(repo, "node_modules")]);
  });

  it("finds lockfile folders in a repository, skipping a linked node_modules", async () => {
    const repo = await createRepo();

    await Promise.all(
      [join(repo, "web"), join(repo, "linked"), join(repo, "web", "node_modules")].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );

    await Promise.all([
      writeFile(join(repo, "web", "pnpm-lock.yaml"), ""),
      writeFile(join(repo, "linked", "yarn.lock"), ""),
      writeFile(join(repo, "bun.lockb"), ""),
    ]);

    await symlink(join(repo, "web", "node_modules"), join(repo, "linked", "node_modules"));

    expect((await discoverAt(repo)).overlays).toEqual(
      [repo, join(repo, "web")].map((dir) => join(dir, "node_modules")),
    );
  });

  it("adds package folders below a lockfile folder of the same repository, at most 256", async () => {
    const repo = await createRepo();
    const packages = Array.from({ length: 257 }, (_, index) => join(repo, "packages", `p${index}`));
    const plain = [join(repo, "node_modules", "dep"), join(repo, "nested", "pkg")];

    await Promise.all([...packages, ...plain].map((dir) => mkdir(dir, { recursive: true })));

    await markRepo(join(repo, "nested"));

    await Promise.all(
      [
        join(repo, "npm-shrinkwrap.json"),
        ...[...packages, ...plain].map((dir) => join(dir, "package.json")),
      ].map((file) => writeFile(file, "{}")),
    );

    const { overlays = [] } = await discoverAt(repo);

    expect(overlays).toHaveLength(257);
    expect(overlays[0]).toBe(join(repo, "node_modules"));
    expect(
      overlays.every(
        (dir) => dir === join(repo, "node_modules") || dir.startsWith(join(repo, "packages", "p")),
      ),
    ).toBe(true);
  });

  it("does not search build output an overlay hides, so large output fits the budget", async () => {
    const repo = await createRepo();
    const venv = join(repo, "app", ".venv");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) => mkdir(join(venv, `pkg${index}`), { recursive: true })),
    );

    await writeFile(join(repo, "app", "uv.lock"), "");

    expect(await discoverAt(repo, { scanBudget: 8 })).toMatchObject({ overlays: [venv] });
  });

  it("skips the .pi folder, so agent worktrees get no overlays", async () => {
    const repo = await createRepo();
    const agent = join(repo, ".pi", "worktrees", "agent-1");

    await markRepo(agent);

    await writeFile(join(agent, "package-lock.json"), "{}");

    expect((await discoverAt(repo)).overlays).toEqual([]);
  });

  it("searches nothing when overlays are off", async () => {
    const repo = await createRepo();

    await writeFile(join(repo, "package-lock.json"), "{}");

    expect((await discoverAt(repo, { overlays: false, scanBudget: 1 })).overlays).toEqual([]);
  });

  it("drops the overlays of a repository too large to search, and says so", async () => {
    const repo = await createRepo();

    await Promise.all(["a", "b", "c"].map((name) => mkdir(join(repo, name, "deep"), { recursive: true })));

    await writeFile(join(repo, "package-lock.json"), "{}");

    expect(await discoverAt(repo, { scanBudget: 3 })).toMatchObject({
      overlays: [],
      overlaysTruncated: true,
    });
    expect((await discoverAt(repo)).overlays).toEqual([join(repo, "node_modules")]);
  });

  it("drops every overlay and says so when there are more than 512", async () => {
    const repo = await createRepo();
    const apps = Array.from({ length: 513 }, (_, index) => join(repo, `app${index}`));

    await Promise.all(apps.map((dir) => mkdir(dir)));

    await Promise.all(apps.map((dir) => writeFile(join(dir, "yarn.lock"), "")));

    expect(await discoverAt(repo)).toMatchObject({ overlays: [], overlaysCapped: true });
  });
});
