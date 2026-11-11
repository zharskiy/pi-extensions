import { chmod, lstat, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type GitGuardContext, planGitOverlay } from "../../container/index.ts";
import { sha256Hex, stateLayout } from "../../shared/index.ts";
import {
  discoverWorkspace,
  gitLaunchEndNotices,
  gitLaunchNotices,
  type Workspace,
  workspaceFolder,
} from "../../workspace/index.ts";
import { git, gitRunner } from "../support/git.ts";
import { tempDir } from "../support/temp-dir.ts";

const discoverAt = async (
  cwd: string,
  ...rest: Parameters<typeof discoverWorkspace> extends [unknown, ...infer R] ? R : never
) => discoverWorkspace(await workspaceFolder(cwd), ...rest);

const runner = gitRunner;

const discoverGitOverlay = async (workspace: Workspace, context: GitGuardContext) =>
  (await planGitOverlay(workspace, context)).overlay;

const readyGitOverlay = async (workspace: Workspace, context: GitGuardContext) =>
  (await planGitOverlay(workspace, context)).ready();

const createBase = async () => {
  const base = await realpath(await tempDir("git"));

  await mkdir(join(base, "home"));

  return base;
};

const createRepo = async (base: string, name = "repo") => {
  const repo = join(base, name);

  await mkdir(repo, { recursive: true });

  await git(repo, ["init", "--quiet"]);

  await writeFile(join(repo, "README.md"), "hello\n");

  await git(repo, ["add", "README.md"]);

  await git(repo, ["commit", "--quiet", "-m", "init"]);

  return repo;
};

const contextOf = (base: string): GitGuardContext => ({ runner, stateDir: join(base, "state") });

const workspaceAt = (base: string, cwd: string) =>
  discoverAt(cwd, runner, join(base, "state", "git", "no-hooks"));

const review = (path: string, verb = "created") =>
  `git: the sandbox ${verb} ${path}; review it before running host git tools in this repository`;

const changedFile = (path: string) =>
  `git: ${path} changed while the sandbox ran; review it before running git there`;

describe("the git dir in the container", () => {
  it("binds .git onto itself and its hooks read-only, and writes nothing into the git dir", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);

    expect(await readyGitOverlay(workspace, contextOf(base))).toEqual({
      selfBinds: [join(repo, ".git")],
      readOnlyDirs: [join(repo, ".git", "hooks")],
    });
    expect(await lstat(join(repo, ".git", "commondir")).catch(() => undefined)).toBeUndefined();
    expect(await lstat(join(repo, ".git", "config.worktree")).catch(() => undefined)).toBeUndefined();
  });

  it("creates a missing hooks dir and leaves it in place without recording it", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);

    await rm(join(repo, ".git", "hooks"), { recursive: true });

    await readyGitOverlay(workspace, contextOf(base));

    expect((await stat(join(repo, ".git", "hooks"))).isDirectory()).toBe(true);
    expect(
      await lstat(stateLayout(join(base, "state")).repo(sha256Hex(repo)).created).catch(() => undefined),
    ).toBeUndefined();
  });

  it("refuses a link planted where a missing hooks dir is about to be created", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const hooks = join(repo, ".git", "hooks");

    await rm(hooks, { recursive: true });

    const plan = await planGitOverlay(workspace, contextOf(base));

    await mkdir(join(base, "home", ".ssh"));
    await symlink(join(base, "home", ".ssh"), hooks);

    await expect(plan.ready()).rejects.toThrow(`git: ${hooks} is a symbolic link`);
  });

  it("refuses a hooks dir it cannot create instead of binding a missing folder", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const hooks = join(repo, ".git", "hooks");

    await rm(hooks, { recursive: true });
    await chmod(join(repo, ".git"), 0o555);

    await expect(
      readyGitOverlay(workspace, contextOf(base)).finally(() => chmod(join(repo, ".git"), 0o755)),
    ).rejects.toThrow(`git: ${hooks} could not be created as a hooks dir (EACCES)`);
  });

  it("binds a linked worktree's common hooks read-only and leaves its .git file and pointers as files", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const worktree = join(base, "linked");

    await git(repo, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

    const overlay = await readyGitOverlay(await workspaceAt(base, worktree), contextOf(base));

    expect(overlay).toEqual({ selfBinds: [], readOnlyDirs: [join(repo, ".git", "hooks")] });
  });

  it("binds submodule hooks dirs and their parents, and accepts a submodule opened as its own repository", async () => {
    const base = await createBase();
    const library = await createRepo(base, "library");
    const repo = await createRepo(base);

    await git(repo, ["submodule", "add", "--quiet", library, "lib"]);

    const module = join(repo, ".git", "modules", "lib");
    const outer = await readyGitOverlay(await workspaceAt(base, repo), contextOf(base));
    const inner = await readyGitOverlay(await workspaceAt(base, join(repo, "lib")), contextOf(base));

    expect(outer).toEqual({
      selfBinds: [join(repo, ".git"), join(repo, ".git", "modules"), module],
      readOnlyDirs: [join(repo, ".git", "hooks"), join(module, "hooks")],
    });
    expect(inner.readOnlyDirs).toEqual([join(module, "hooks")]);
  });

  it("refuses a symlinked module hooks dir and never binds the link target", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const module = join(repo, ".git", "modules", "m");

    await mkdir(module, { recursive: true });
    await writeFile(join(module, "HEAD"), "ref: refs/heads/main\n");
    await symlink(join(base, "home"), join(module, "hooks"));

    await expect(readyGitOverlay(workspace, contextOf(base))).rejects.toThrow(
      `git: ${join(module, "hooks")} is a symbolic link`,
    );
  });

  it("refuses a commondir planted in the git dir before the start", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const plan = await planGitOverlay(workspace, contextOf(base));

    await writeFile(join(repo, ".git", "commondir"), "../elsewhere\n");

    await expect(plan.ready()).rejects.toThrow(
      `git: ${join(repo, ".git", "commondir")} was not written by git`,
    );
  });

  it("leaves a git dir alone outside git", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);

    expect(await discoverGitOverlay({ ...workspace, gitCommonDir: undefined }, contextOf(base))).toEqual({
      selfBinds: [],
      readOnlyDirs: [],
    });
  });
});

describe("the git dirs of a workspace in the container", () => {
  it("binds a bare repository in the folder read-only as one directory and the folders above it onto themselves", async () => {
    const base = await createBase();
    const root = join(base, "work");
    const bare = join(root, "shared", "remote.git");

    await mkdir(join(root, "shared"), { recursive: true });

    await git(root, ["init", "--quiet", "--bare", bare]);

    const overlay = await readyGitOverlay(await workspaceAt(base, root), contextOf(base));

    expect(overlay).toEqual({ selfBinds: [join(root, "shared")], readOnlyDirs: [bare] });
    expect(await lstat(join(bare, "commondir")).catch(() => undefined)).toBeUndefined();
  });

  it("refuses when a bare dir changed between discovery and the start", async () => {
    const base = await createBase();
    const root = join(base, "work");
    const bare = join(root, "remote.git");

    await mkdir(root, { recursive: true });

    await git(root, ["init", "--quiet", "--bare", bare]);

    const plan = await planGitOverlay(await workspaceAt(base, root), contextOf(base));

    await rm(bare, { recursive: true });
    await writeFile(bare, "");

    await expect(plan.ready()).rejects.toMatchObject({
      message: `workspace: ${bare} changed while pi was starting, refusing`,
      hint: "run pi again",
    });
  });

  it("mounts a checkout whose git dir lies outside the folder as plain files", async () => {
    const base = await createBase();
    const root = join(base, "work");
    const main = await createRepo(base, "main");
    const worktree = join(root, "team", "linked");

    await mkdir(join(root, "team"), { recursive: true });

    await git(main, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

    const plan = await planGitOverlay(await workspaceAt(base, root), contextOf(base));

    await rm(join(worktree, ".git"));

    expect(await plan.ready()).toEqual({ selfBinds: [], readOnlyDirs: [] });
  });

  it("binds the hooks of every nested repository and self-binds each root and the folders above it", async () => {
    const base = await createBase();
    const folder = join(base, "projects");
    const first = await createRepo(folder, "app");
    const second = await createRepo(folder, join("group", "lib"));

    const overlay = await readyGitOverlay(await workspaceAt(base, folder), contextOf(base));

    expect(overlay.readOnlyDirs.sort()).toEqual([
      join(first, ".git", "hooks"),
      join(second, ".git", "hooks"),
    ]);
    expect(overlay.selfBinds).toEqual([
      first,
      join(folder, "group"),
      join(first, ".git"),
      second,
      join(second, ".git"),
    ]);
  });
});

describe("the git checks around a session", () => {
  it("names alternates before the launch", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);

    await writeFile(join(repo, ".git", "objects", "info", "alternates"), "/elsewhere/objects\n");

    expect(await gitLaunchNotices(workspace)).toEqual([
      `git: ${join(repo, ".git", "objects", "info", "alternates")} is present, so host git also reads objects from the places it lists; check it if you did not set it up`,
    ]);
  });

  it("reports a nested repository and a gitlink the sandbox added", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);

    await readyGitOverlay(workspace, contextOf(base));

    await createRepo(repo, "vendor/nested");

    await git(repo, ["add", "vendor/nested"]);

    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([
      review(join(repo, "vendor", "nested", ".git")),
      `git: the sandbox added the gitlink ${join(repo, "vendor", "nested")} (a nested repository); review it before running host git tools in this repository`,
    ]);
  });

  it("reports a commondir planted in a module git dir as a broken layout", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const module = join(repo, ".git", "modules", "m");

    await readyGitOverlay(workspace, contextOf(base));

    await mkdir(module, { recursive: true });
    await writeFile(join(module, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(module, "commondir"), "../../../.x\n");

    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([
      `git: ${join(module, "commondir")} was not written by git`,
    ]);
  });

  it("reports a link planted under .git after the session instead of refusing", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const planted = join(repo, ".git", "modules", "m");

    await readyGitOverlay(workspace, contextOf(base));

    await mkdir(join(repo, ".git", "modules"));
    await symlink(join(base, "home"), planted);

    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([
      `git: ${planted} is a symbolic link`,
    ]);
  });

  it("reports each of the repository's own git files that changed, and nothing when none did", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const worktree = join(base, "wt");

    await readyGitOverlay(workspace, contextOf(base));

    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([]);

    await readyGitOverlay(workspace, contextOf(base));
    await git(repo, ["config", "user.name", "changed"]);
    await writeFile(join(repo, ".git", "config.worktree"), "");
    await git(repo, ["worktree", "add", "--quiet", "-b", "wt", worktree]);

    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([
      changedFile(join(repo, ".git", "config")),
      changedFile(join(repo, ".git", "config.worktree")),
      changedFile(join(repo, ".git", "worktrees", "wt", "commondir")),
      changedFile(join(repo, ".git", "worktrees", "wt", "gitdir")),
    ]);
  });

  it("reports a changed submodule config and a changed .git file of the launched checkout", async () => {
    const base = await createBase();
    const library = await createRepo(base, "library");
    const repo = await createRepo(base);

    await git(repo, ["submodule", "add", "--quiet", library, "lib"]);

    const module = join(repo, ".git", "modules", "lib");
    const outer = await workspaceAt(base, repo);
    const inner = await workspaceAt(base, join(repo, "lib"));

    await readyGitOverlay(outer, contextOf(base));
    await readyGitOverlay(inner, contextOf(base));
    await git(join(repo, "lib"), ["config", "user.name", "changed"]);
    await writeFile(join(repo, "lib", ".git"), `gitdir: ${module}\n`);

    expect(await gitLaunchEndNotices(outer, contextOf(base))).toEqual([
      changedFile(join(module, "config")),
      review(join(repo, "lib", ".git"), "changed"),
    ]);
    expect(await gitLaunchEndNotices(inner, contextOf(base))).toEqual([
      changedFile(join(module, "config")),
      changedFile(join(repo, "lib", ".git")),
    ]);
  });

  it("reports a changed config inside a nested .git dir", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const nested = await createRepo(repo, "vendor");
    const workspace = await workspaceAt(base, repo);

    await readyGitOverlay(workspace, contextOf(base));
    await git(nested, ["config", "user.name", "changed"]);

    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([
      review(join(nested, ".git"), "changed"),
    ]);
  });

  it("leaves nested .git entries under mounted volumes out of the session-end report", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const volume = join(repo, "node_modules");
    const mounted = { ...contextOf(base), volumePaths: [volume] };

    await mkdir(volume);
    await readyGitOverlay(workspace, mounted);
    await createRepo(volume, "package");

    expect(await gitLaunchEndNotices(workspace, mounted)).toEqual([]);

    await rm(join(volume, "package"), { recursive: true });
    await readyGitOverlay(workspace, contextOf(base));
    await createRepo(volume, "package");

    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([
      review(join(volume, "package", ".git")),
    ]);
  });

  it("records the baseline of a workspace without repositories, so one made during the session is reported", async () => {
    const base = await createBase();
    const folder = join(base, "folder");

    await mkdir(folder);

    const workspace = await workspaceAt(base, folder);

    await readyGitOverlay(workspace, contextOf(base));
    await createRepo(folder, "made");

    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([
      review(join(folder, "made", ".git")),
    ]);
  });
});

describe("the session-end report across several launches of a repository", () => {
  it("keeps the earliest live launch's baseline and reports at the last launch's end", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);

    await readyGitOverlay(workspace, contextOf(base));

    const made = await createRepo(repo, "made");
    const second = await planGitOverlay(workspace, contextOf(base));

    await second.ready({ othersLive: true });

    expect(second.pendingNotices()).toEqual([]);
    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([review(join(made, ".git"))]);
  });

  it("reports at the next launch what a session that ended without its check left, and each change once", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);

    await readyGitOverlay(workspace, contextOf(base));

    const left = await createRepo(repo, "left");
    const plan = await planGitOverlay(workspace, contextOf(base));

    await plan.ready();

    expect(plan.pendingNotices()).toEqual([
      "git: the check after the last sandbox session did not run; it reports now:",
      review(join(left, ".git")),
    ]);
    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([]);

    await createRepo(repo, "later");

    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([]);

    const next = await planGitOverlay(workspace, contextOf(base));

    await next.ready();

    expect(next.pendingNotices()).toEqual([]);
  });
});
