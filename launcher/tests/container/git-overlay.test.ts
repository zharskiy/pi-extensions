import { lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LABELS, type MountSpec } from "../../backend/index.ts";
import {
  buildContainerSpec,
  type GitGuardContext,
  type GitOverlay,
  gitDirInUseElsewhere,
  planGitOverlay,
} from "../../container/index.ts";
import { readPins, sha256Hex, stateLayout, writePins } from "../../shared/index.ts";
import {
  discoverWorkspace,
  gitLaunchEndNotices,
  gitLaunchNotices,
  unpinRecorded,
  type Workspace,
  workspaceFolder,
} from "../../workspace/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { git, gitRunner } from "../support/git.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
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

const contextOf = (base: string, gitRunner = runner): GitGuardContext => ({
  runner: gitRunner,
  home: join(base, "home"),
  env: {},
  stateDir: join(base, "state"),
});

const idle = async () => false;

const releasePins = async (base: string, repo: string, inUse: (gitCommonDir: string) => Promise<boolean>) => {
  const stateDir = join(base, "state");
  const { kept, notices } = await unpinRecorded(stateDir, await readPins(stateDir, sha256Hex(repo)), inUse);

  await writePins(stateDir, sha256Hex(repo), kept);

  return notices;
};

const busy = async () => true;

const workspaceAt = (base: string, cwd: string) =>
  discoverAt(cwd, runner, join(base, "state", "git", "no-hooks"));

const specOf = (base: string, workspace: Workspace, gitOverlay: GitOverlay) =>
  buildContainerSpec({
    workspace,
    config: sandboxConfig(),
    image: { reference: "pi-sandbox:local", digest: "sha256:one", id: "sha256:image-one" },
    hostEnv: { USER: "dev", HOME: join(base, "home") },
    hostUid: 501,
    stateDir: join(base, "state"),
    gitOverlay,
    launcherVersion: "0.4.0",
  });

const gitMountsOf = (spec: { mounts: MountSpec[] }, repo: string) =>
  spec.mounts.filter((mount) => mount.kind === "bind" && mount.target.startsWith(repo));

const describeMount = (base: string, mount: MountSpec) => ({
  target: mount.target,
  readOnly: mount.readOnly,
  copy: mount.source.startsWith(join(base, "state", "repos")),
});

describe("the git dir in the container", () => {
  it("binds .git onto itself, hooks and the commondir pin read-only from the host and config from a copy", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const spec = specOf(base, workspace, await discoverGitOverlay(workspace, contextOf(base)));

    expect(gitMountsOf(spec, repo).map((mount) => describeMount(base, mount))).toEqual([
      { target: repo, readOnly: false, copy: false },
      { target: join(repo, ".git"), readOnly: false, copy: false },
      { target: join(repo, ".git", "hooks"), readOnly: true, copy: false },
      { target: join(repo, ".git", "config"), readOnly: true, copy: true },
      { target: join(repo, ".git", "commondir"), readOnly: true, copy: false },
    ]);
  });

  it("writes and records the pin and a private copy of the config before a start, and binds the hooks from the host", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);

    await writeFile(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const overlay = await readyGitOverlay(workspace, contextOf(base));
    const spec = specOf(base, workspace, overlay);
    const sourceAt = (target: string) =>
      gitMountsOf(spec, repo).find((mount) => mount.target === target)?.source ?? "";
    const hooks = sourceAt(join(repo, ".git", "hooks"));

    expect(await readFile(join(repo, ".git", "commondir"), "utf8")).toBe(".\n");
    expect(sourceAt(join(repo, ".git", "commondir"))).toBe(join(repo, ".git", "commondir"));
    expect(await readFile(sourceAt(join(repo, ".git", "config")), "utf8")).toBe(
      await readFile(join(repo, ".git", "config"), "utf8"),
    );
    expect(sourceAt(join(repo, ".git", "config"))).not.toBe(join(repo, ".git", "config"));
    expect(hooks).toBe(join(repo, ".git", "hooks"));
    expect(await readPins(join(base, "state"), sha256Hex(repo))).toEqual([
      { path: join(repo, ".git", "commondir"), gitCommonDir: join(repo, ".git") },
    ]);
  });

  it("never copies the target of a symlinked hook into the state dir", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const secret = join(base, "home", "secret");
    const workspace = await workspaceAt(base, repo);

    await writeFile(secret, "secret-value\n");

    await symlink(secret, join(repo, ".git", "hooks", "post-checkout"));

    const spec = specOf(base, workspace, await readyGitOverlay(workspace, contextOf(base)));
    const copies = await readdir(stateLayout(join(base, "state")).repo(sha256Hex(repo)).git);
    const texts = await Promise.all(
      copies.map((name) =>
        readFile(join(stateLayout(join(base, "state")).repo(sha256Hex(repo)).git, name), "utf8"),
      ),
    );

    expect(spec.mounts.find((mount) => mount.target === join(repo, ".git", "hooks"))?.source).toBe(
      join(repo, ".git", "hooks"),
    );
    expect(texts.some((text) => text.includes("secret-value"))).toBe(false);
  });

  it("protects a linked worktree's .git file, its gitdir pointers and the common dir pin", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const worktree = join(base, "linked");

    await git(repo, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

    const workspace = await workspaceAt(base, worktree);
    const overlay = await discoverGitOverlay(workspace, contextOf(base));
    const gitDir = join(repo, ".git", "worktrees", "linked");
    const mounts = specOf(base, workspace, overlay).mounts.map((mount) => describeMount(base, mount));

    expect(mounts.filter((mount) => mount.target.startsWith(base))).toEqual([
      { target: worktree, readOnly: false, copy: false },
      { target: join(repo, ".git"), readOnly: false, copy: false },
      { target: join(repo, ".git", "worktrees"), readOnly: false, copy: false },
      { target: gitDir, readOnly: false, copy: false },
      { target: join(repo, ".git", "hooks"), readOnly: true, copy: false },
      { target: join(repo, ".git", "config"), readOnly: true, copy: true },
      { target: join(gitDir, "commondir"), readOnly: true, copy: false },
      { target: join(gitDir, "gitdir"), readOnly: true, copy: false },
      { target: join(worktree, ".git"), readOnly: true, copy: false },
      { target: join(repo, ".git", "commondir"), readOnly: true, copy: false },
    ]);
  });

  it("protects submodule git dirs and accepts a submodule opened as its own repository", async () => {
    const base = await createBase();
    const library = await createRepo(base, "library");
    const repo = await createRepo(base);

    await git(repo, ["submodule", "add", "--quiet", library, "lib"]);

    const module = join(repo, ".git", "modules", "lib");
    const outer = await discoverGitOverlay(await workspaceAt(base, repo), contextOf(base));
    const inner = await discoverGitOverlay(await workspaceAt(base, join(repo, "lib")), contextOf(base));

    expect(outer.selfBinds).toEqual([join(repo, ".git"), join(repo, ".git", "modules"), module]);
    expect(outer.readOnlyDirs).toEqual(expect.arrayContaining([join(module, "hooks")]));
    expect(outer.readOnlyFiles).toEqual(
      expect.arrayContaining([
        join(module, "config"),
        join(module, "commondir"),
        join(repo, ".git", "commondir"),
      ]),
    );
    expect(inner.readOnlyFiles).toEqual(
      expect.arrayContaining([join(repo, "lib", ".git"), join(module, "config"), join(module, "commondir")]),
    );
  });

  it("refuses a symlinked config.worktree or module hooks dir and never binds the link target", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const secret = join(base, "home", ".pi", "agent", "auth.json");
    const module = join(repo, ".git", "modules", "m");

    await mkdir(join(base, "home", ".pi", "agent"), { recursive: true });
    await writeFile(secret, "{}\n");
    await symlink(secret, join(repo, ".git", "config.worktree"));

    await expect(discoverGitOverlay(workspace, contextOf(base))).rejects.toThrow(
      `git: ${join(repo, ".git", "config.worktree")} is a symbolic link`,
    );

    await rm(join(repo, ".git", "config.worktree"));
    await mkdir(module, { recursive: true });
    await writeFile(join(module, "HEAD"), "ref: refs/heads/main\n");
    await symlink(join(base, "home"), join(module, "hooks"));

    await expect(readyGitOverlay(workspace, contextOf(base))).rejects.toThrow(
      `git: ${join(module, "hooks")} is a symbolic link`,
    );
  });

  it("refuses a hooks path through a link in the repository and leaves out one outside it", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const overlayWith = async (hooksPath: string) => {
      await git(repo, ["config", "core.hooksPath", hooksPath]);

      return discoverGitOverlay(await workspaceAt(base, repo), contextOf(base));
    };

    await mkdir(join(repo, "tools", "hooks"), { recursive: true });
    await mkdir(join(base, "outside-hooks"));
    await symlink(join(repo, "tools"), join(repo, "linked"));

    expect((await overlayWith("tools/hooks")).readOnlyDirs).toContain(join(repo, "tools", "hooks"));
    expect((await overlayWith(join(base, "outside-hooks"))).readOnlyDirs).toEqual([
      join(repo, ".git", "hooks"),
    ]);
    await expect(overlayWith("linked/hooks")).rejects.toThrow(
      "(core.hooksPath) goes through a symbolic link",
    );
  });

  it("creates a missing hooks dir and binds its parents so the sandbox cannot rename them away", async () => {
    const base = await createBase();
    const repo = await createRepo(base);

    await rm(join(repo, ".git", "hooks"), { recursive: true });

    await git(repo, ["config", "core.hooksPath", ".husky/_"]);

    const workspace = await workspaceAt(base, repo);

    const overlay = await readyGitOverlay(workspace, contextOf(base));

    expect((await stat(join(repo, ".husky", "_"))).isDirectory()).toBe(true);
    expect((await stat(join(repo, ".git", "hooks"))).isDirectory()).toBe(true);
    expect(overlay.selfBinds).toEqual([join(repo, ".git"), join(repo, ".husky")]);
  });

  it("refuses a link planted where a missing hooks dir is about to be created, and copies nothing", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const hooks = join(repo, ".git", "hooks");

    await rm(hooks, { recursive: true });

    const plan = await planGitOverlay(workspace, contextOf(base));

    await mkdir(join(base, "home", ".ssh"));
    await symlink(join(base, "home", ".ssh"), hooks);

    await expect(plan.ready()).rejects.toThrow(`git: ${hooks} is a symbolic link`);
    expect(
      await lstat(
        stateLayout(join(base, "state"))
          .repo(sha256Hex(repo))
          .gitCopy(join(repo, ".git", "config")),
      ).catch(() => undefined),
    ).toBeUndefined();
  });

  it("refuses a hooks dir created through a parent the sandbox side turned into a link", async () => {
    const base = await createBase();
    const repo = await createRepo(base);

    await git(repo, ["config", "core.hooksPath", ".husky/_"]);

    const workspace = await workspaceAt(base, repo);

    const plan = await planGitOverlay(workspace, contextOf(base));

    await mkdir(join(base, "elsewhere"));
    await symlink(join(base, "elsewhere"), join(repo, ".husky"));

    await expect(plan.ready()).rejects.toThrow(
      `git: ${join(repo, ".husky", "_")} goes through a symbolic link`,
    );
  });

  it("refuses a git leaf that is a link to a protected path even though the guard trusts real paths", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const ssh = join(base, "home", ".ssh");

    await mkdir(ssh);
    await rm(join(repo, ".git", "hooks"), { recursive: true });
    await symlink(ssh, join(repo, ".git", "hooks"));

    await expect(discoverGitOverlay(workspace, contextOf(base))).rejects.toThrow(
      `git: ${join(repo, ".git", "hooks")} is a symbolic link`,
    );
  });

  it("leaves a git dir alone outside git and when git itself fails", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const failing = createFakeRunner(() => undefined).runner;

    expect(await discoverGitOverlay({ ...workspace, gitCommonDir: undefined }, contextOf(base))).toEqual({
      selfBinds: [],
      readOnlyDirs: [],
      readOnlyFiles: [],
    });
    expect((await discoverGitOverlay(workspace, contextOf(base, failing))).readOnlyDirs).toEqual([
      join(repo, ".git", "hooks"),
    ]);
  });
});

const mountAt = (mounts: MountSpec[], target: string) => mounts.find((mount) => mount.target === target);

const coveringMount = (mounts: MountSpec[], path: string) =>
  mounts
    .filter((mount) => path === mount.target || path.startsWith(`${mount.target}/`))
    .sort((first, second) => second.target.length - first.target.length)[0];

describe("the git dirs of a workspace in the container", () => {
  it("binds a bare repository in the folder read-only as one mount, so nothing can be planted in it", async () => {
    const base = await createBase();
    const root = join(base, "work");
    const bare = join(root, "shared", "remote.git");

    await mkdir(join(root, "shared"), { recursive: true });

    await git(root, ["init", "--quiet", "--bare", bare]);

    const workspace = await workspaceAt(base, root);
    const overlay = await readyGitOverlay(workspace, contextOf(base));
    const spec = specOf(base, workspace, overlay);
    const mounts = spec.mounts;

    expect(
      mounts.filter((mount) => mount.target.startsWith(bare)).map((mount) => describeMount(base, mount)),
    ).toEqual([{ target: bare, readOnly: true, copy: false }]);
    expect(mountAt(mounts, join(root, "shared"))).toMatchObject({
      readOnly: false,
      source: join(root, "shared"),
    });
    expect(
      [
        join(bare, ".git"),
        join(bare, "hooks", "pre-receive"),
        join(bare, "modules", "x"),
        join(bare, "packed-refs"),
      ].map((path) => coveringMount(mounts, path)?.target),
    ).toEqual([bare, bare, bare, bare]);
    expect(await lstat(join(bare, "commondir")).catch(() => undefined)).toBeUndefined();
    expect(spec.labels[LABELS.gitCommonDirs]).toBeUndefined();
  });

  it("refuses when a bare dir, a detached .git or a masked folder changed between discovery and the start", async () => {
    const base = await createBase();
    const root = join(base, "work");
    const bare = join(root, "remote.git");
    const checkout = join(root, "linked");
    const locked = join(root, "locked");
    const main = await createRepo(base, "main");

    await mkdir(locked, { recursive: true });

    await git(root, ["init", "--quiet", "--bare", bare]);
    await git(main, ["worktree", "add", "--quiet", "-b", "feature", checkout]);

    const workspace = { ...(await workspaceAt(base, root)), masked: [locked] };
    const plan = await planGitOverlay(workspace, contextOf(base));
    const changed = (path: string) => ({
      message: `workspace: ${path} changed while pi was starting, refusing`,
      hint: "run pi again",
    });

    await rm(locked, { recursive: true });
    await symlink(join(base, "home"), locked);

    await expect(plan.ready()).rejects.toMatchObject(changed(locked));

    await rm(locked);
    await mkdir(locked);
    await rm(join(checkout, ".git"));

    await expect(plan.ready()).rejects.toMatchObject(changed(join(checkout, ".git")));

    await writeFile(join(checkout, ".git"), `gitdir: ${join(main, ".git", "worktrees", "linked")}\n`);
    await rm(bare, { recursive: true });
    await writeFile(bare, "");

    await expect(plan.ready()).rejects.toMatchObject(changed(bare));
  });

  it("binds a nested .git file that leads outside the folder read-only and mounts nothing outside", async () => {
    const base = await createBase();
    const root = join(base, "work");
    const main = await createRepo(base, "main");
    const worktree = join(root, "team", "linked");

    await mkdir(join(root, "team"), { recursive: true });

    await git(main, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

    const workspace = await workspaceAt(base, root);
    const mounts = specOf(base, workspace, await readyGitOverlay(workspace, contextOf(base))).mounts;

    expect(mounts.filter((mount) => mount.kind === "bind" && mount.source.startsWith(main))).toEqual([]);
    expect(mountAt(mounts, join(worktree, ".git"))).toMatchObject({
      readOnly: true,
      source: join(worktree, ".git"),
    });
    expect(mountAt(mounts, worktree)).toMatchObject({ readOnly: false });
    expect(mountAt(mounts, join(root, "team"))).toMatchObject({ readOnly: false });
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

  it("removes the recorded pin after the session and leaves a commondir that no longer holds it", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const pin = join(repo, ".git", "commondir");

    await readyGitOverlay(workspace, contextOf(base));

    expect(await releasePins(base, repo, idle)).toEqual([]);
    expect(await lstat(pin).catch(() => undefined)).toBeUndefined();
    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([]);

    await readyGitOverlay(workspace, contextOf(base));

    await writeFile(pin, "../.x\n");

    expect(await releasePins(base, repo, idle)).toEqual([
      `git: ${pin} no longer holds the launcher's pin, so it was left in place`,
    ]);
    expect(await readFile(pin, "utf8")).toBe("../.x\n");
  });

  it("keeps the pins while another running sandbox shares the git dir", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);

    await readyGitOverlay(workspace, contextOf(base));

    expect(await releasePins(base, repo, busy)).toEqual([]);
    expect(await readFile(join(repo, ".git", "commondir"), "utf8")).toBe(".\n");
  });

  it("keeps the pins while a sandbox of another checkout sharing the git dir is created but not started", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const fake = createFakeBackend();

    fake.addContainer({
      name: "pi-sandbox-sibling",
      labels: {
        [LABELS.managed]: "true",
        [LABELS.repoHash]: "sibling",
        [LABELS.gitCommonDir]: join(repo, ".git"),
      },
      state: "created",
      image: "sha256:image-one",
    });

    await readyGitOverlay(workspace, contextOf(base));

    expect(
      await releasePins(base, repo, (gitCommonDir) =>
        gitDirInUseElsewhere(fake.backend, sha256Hex(repo), gitCommonDir),
      ),
    ).toEqual([]);
    expect(await readFile(join(repo, ".git", "commondir"), "utf8")).toBe(".\n");
  });

  it("reports a nested repository and a gitlink the sandbox added", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);

    await readyGitOverlay(workspace, contextOf(base));

    await createRepo(repo, "vendor/nested");

    await git(repo, ["add", "vendor/nested"]);

    const notices = await gitLaunchEndNotices(workspace, contextOf(base));

    expect(notices).toEqual([
      `git: the sandbox created ${join(repo, "vendor", "nested", ".git")}; review it before running host git tools in this repository`,
      `git: the sandbox added the gitlink ${join(repo, "vendor", "nested")} (a nested repository); review it before running host git tools in this repository`,
    ]);
  });

  it("reports a commondir the sandbox planted in a module git dir", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const module = join(repo, ".git", "modules", "m");

    await readyGitOverlay(workspace, contextOf(base));

    await mkdir(module, { recursive: true });
    await writeFile(join(module, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(module, "commondir"), "../../../.x\n");

    await releasePins(base, repo, idle);

    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([
      `git: ${join(module, "commondir")} was not written by git or the launcher`,
    ]);
  });

  it("reports a link the sandbox planted under .git after the session instead of refusing", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const planted = join(repo, ".git", "modules", "m");

    await readyGitOverlay(workspace, contextOf(base));

    await mkdir(join(repo, ".git", "modules"));
    await symlink(join(base, "home"), planted);

    await releasePins(base, repo, idle);

    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([
      `git: ${planted} is a symbolic link`,
    ]);
    expect(await lstat(join(repo, ".git", "commondir")).catch(() => undefined)).toBeUndefined();
  });
});

describe("the git dirs of a workspace in the container", () => {
  const createFolder = async () => {
    const base = await createBase();
    const folder = join(base, "projects");
    const first = await createRepo(folder, "app");
    const second = await createRepo(folder, join("group", "lib"));

    return { base, folder, first, second };
  };

  it("binds each nested repository's git files read-only and its root and parents onto themselves", async () => {
    const { base, folder, first, second } = await createFolder();
    const workspace = await workspaceAt(base, folder);
    const spec = specOf(base, workspace, await discoverGitOverlay(workspace, contextOf(base)));
    const mounts = gitMountsOf(spec, folder).map((mount) => describeMount(base, mount));
    const indexOf = (target: string) => mounts.findIndex((mount) => mount.target === target);

    expect(mounts).toEqual(
      expect.arrayContaining([
        { target: folder, readOnly: false, copy: false },
        { target: first, readOnly: false, copy: false },
        { target: join(folder, "group"), readOnly: false, copy: false },
        { target: second, readOnly: false, copy: false },
        { target: join(first, ".git", "hooks"), readOnly: true, copy: false },
        { target: join(first, ".git", "config"), readOnly: true, copy: true },
        { target: join(second, ".git", "hooks"), readOnly: true, copy: false },
        { target: join(second, ".git", "config"), readOnly: true, copy: true },
      ]),
    );
    expect(indexOf(join(folder, "group"))).toBeLessThan(indexOf(second));
    expect(indexOf(second)).toBeLessThan(indexOf(join(second, ".git", "config")));
    expect(JSON.parse(spec.labels[LABELS.gitCommonDirs] ?? "[]")).toEqual([
      join(first, ".git"),
      join(second, ".git"),
    ]);
  });

  it("binds the hooks of every nested repository and pins them in one start", async () => {
    const { base, folder, first, second } = await createFolder();
    const workspace = await workspaceAt(base, folder);

    await writeFile(join(first, ".git", "hooks", "pre-commit"), "first\n");

    await writeFile(join(second, ".git", "hooks", "pre-commit"), "second\n");

    const spec = specOf(base, workspace, await readyGitOverlay(workspace, contextOf(base)));
    const hookOf = (repo: string) => {
      const source = spec.mounts.find((mount) => mount.target === join(repo, ".git", "hooks"))?.source ?? "";

      return readFile(join(source, "pre-commit"), "utf8");
    };

    expect(await hookOf(first)).toBe("first\n");
    expect(await hookOf(second)).toBe("second\n");
    expect((await readPins(join(base, "state"), sha256Hex(folder))).map((pin) => pin.path).sort()).toEqual(
      [join(first, ".git", "commondir"), join(second, ".git", "commondir")].sort(),
    );
    expect(await readFile(join(second, ".git", "commondir"), "utf8")).toBe(".\n");
  });

  it("recreates the container when a nested repository appears", async () => {
    const { base, folder } = await createFolder();
    const hashOf = async () => {
      const workspace = await workspaceAt(base, folder);

      return specOf(base, workspace, await discoverGitOverlay(workspace, contextOf(base))).labels[
        LABELS.specHash
      ];
    };
    const before = await hashOf();

    await createRepo(folder, "tools");

    expect(await hashOf()).not.toBe(before);
  });

  it("refuses a nested repository whose hooks path lies in the workspace outside it", async () => {
    const { base, folder, first } = await createFolder();

    await mkdir(join(folder, "shared-hooks"));

    await git(first, ["config", "core.hooksPath", join(folder, "shared-hooks")]);

    const workspace = await workspaceAt(base, folder);

    await expect(discoverGitOverlay(workspace, contextOf(base))).rejects.toThrow("lies inside the workspace");
  });
});

describe("the git paths only a repository's own layout reveals", () => {
  const withSubmoduleInWorktree = async () => {
    const base = await createBase();
    const library = await createRepo(base, "library");
    const repo = await createRepo(base);
    const worktree = join(base, "linked");

    await git(repo, ["submodule", "add", "--quiet", library, "lib"]);
    await git(repo, ["commit", "--quiet", "-m", "lib"]);
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature", worktree]);
    await git(worktree, ["submodule", "update", "--init", "--quiet"]);

    return { base, repo, worktree, module: join(repo, ".git", "worktrees", "linked", "modules", "lib") };
  };

  it("protects the submodule git dirs of a linked worktree from the worktree and from the main checkout", async () => {
    const { base, repo, worktree, module } = await withSubmoduleInWorktree();

    expect(await readFile(join(worktree, "lib", ".git"), "utf8")).toContain("worktrees/linked/modules/lib");

    const fromWorktree = await readyGitOverlay(await workspaceAt(base, worktree), contextOf(base));
    const fromMain = await discoverGitOverlay(await workspaceAt(base, repo), contextOf(base));

    [fromWorktree, fromMain].forEach((overlay) => {
      expect(overlay.readOnlyDirs).toContain(join(module, "hooks"));
      expect(overlay.readOnlyFiles).toEqual(
        expect.arrayContaining([join(module, "config"), join(module, "commondir")]),
      );
    });
    expect(await readFile(join(module, "commondir"), "utf8")).toBe(".\n");
    expect(await readPins(join(base, "state"), sha256Hex(worktree))).toContainEqual({
      path: join(module, "commondir"),
      gitCommonDir: join(repo, ".git"),
    });
  });

  it("refuses an include the sandbox could create, naming the include and the path", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const shared = join(repo, "shared.gitconfig");

    await git(repo, ["config", "include.path", "../shared.gitconfig"]);

    const workspace = await workspaceAt(base, repo);

    await expect(discoverGitOverlay(workspace, contextOf(base))).rejects.toMatchObject({
      message: `git: ${join(repo, ".git", "config")} includes ${shared}, which does not exist; the sandbox could create it with settings host git would then run`,
      hint: `create it empty with touch ${shared} (an empty file changes nothing for git), or remove the include from ${join(repo, ".git", "config")}`,
    });

    await writeFile(shared, "");

    expect((await discoverGitOverlay(workspace, contextOf(base))).readOnlyFiles).toContain(shared);
  });

  it("binds an include whose condition is false at launch and leaves out one outside the repository", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const branchConfig = join(repo, "branch.gitconfig");

    await writeFile(branchConfig, "[user]\n\tname = test\n");
    await git(repo, ["config", "includeIf.onbranch:elsewhere.path", "../branch.gitconfig"]);
    await git(repo, ["config", "--add", "include.path", join(base, "outside.gitconfig")]);

    const overlay = await discoverGitOverlay(await workspaceAt(base, repo), contextOf(base));

    expect(overlay.readOnlyFiles).toContain(branchConfig);
    expect(overlay.readOnlyFiles.some((path) => path.includes("outside.gitconfig"))).toBe(false);
  });

  it("refuses a missing config.worktree only while extensions.worktreeConfig is on", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const worktree = join(base, "linked");
    const ownConfig = join(repo, ".git", "config.worktree");
    const linkedConfig = join(repo, ".git", "worktrees", "linked", "config.worktree");

    await git(repo, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

    expect(
      (await discoverGitOverlay(await workspaceAt(base, repo), contextOf(base))).readOnlyFiles,
    ).not.toContain(ownConfig);

    await git(repo, ["config", "extensions.worktreeConfig", "true"]);

    await expect(discoverGitOverlay(await workspaceAt(base, repo), contextOf(base))).rejects.toMatchObject({
      message: `git: ${ownConfig} is missing; extensions.worktreeConfig (which git sparse-checkout turns on) makes git read it, so the sandbox could create it with settings host git would then run`,
      hint: `create it empty with touch ${ownConfig} (an empty file changes nothing for git)`,
    });

    await writeFile(ownConfig, "");

    await expect(discoverGitOverlay(await workspaceAt(base, worktree), contextOf(base))).rejects.toThrow(
      `git: ${linkedConfig} is missing`,
    );

    await writeFile(linkedConfig, "");

    expect(
      (await discoverGitOverlay(await workspaceAt(base, worktree), contextOf(base))).readOnlyFiles,
    ).toEqual(expect.arrayContaining([ownConfig, linkedConfig]));
  });

  it("refuses a required file that disappears between the plan and the start", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const shared = join(repo, "shared.gitconfig");

    await writeFile(shared, "");
    await git(repo, ["config", "include.path", "../shared.gitconfig"]);

    const plan = await planGitOverlay(await workspaceAt(base, repo), contextOf(base));

    await rm(shared);

    await expect(plan.ready()).rejects.toThrow(`includes ${shared}, which does not exist`);
  });

  it("records a commondir pin discovery filled in place, so the session end removes it", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const pin = join(repo, ".git", "commondir");

    await writeFile(pin, "");

    const workspace = await workspaceAt(base, repo);

    expect(await readFile(pin, "utf8")).toBe(".\n");

    await readyGitOverlay(workspace, contextOf(base));

    expect(await readPins(join(base, "state"), sha256Hex(repo))).toEqual([
      { path: pin, gitCommonDir: join(repo, ".git") },
    ]);
    expect(await releasePins(base, repo, idle)).toEqual([]);
    expect(await lstat(pin).catch(() => undefined)).toBeUndefined();
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
    expect(await gitLaunchEndNotices(workspace, contextOf(base))).toEqual([
      `git: the sandbox created ${join(volume, "package", ".git")}; review it before running host git tools in this repository`,
    ]);
  });
});

describe("the git configuration a branch switch, a worktree or a submodule can bring in", () => {
  const recordingRunner = () => {
    const calls: string[] = [];
    const recorder = {
      ...runner,
      run: (file: string, args: string[], options?: Parameters<typeof runner.run>[2]) => {
        calls.push(args.find((arg) => ["rev-parse", "config", "ls-files"].includes(arg)) ?? args.join(" "));

        return runner.run(file, args, options);
      },
    };

    return { recorder, calls };
  };

  it("binds a relative hooksPath in every linked worktree inside the repository, where host git runs it", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const feat = join(repo, ".worktrees", "feat");
    const marker = join(base, "ran");

    await git(repo, ["config", "core.hooksPath", ".githooks"]);
    await git(repo, ["worktree", "add", "--quiet", "-b", "feat", feat]);
    await mkdir(join(feat, ".githooks"));
    await writeFile(join(feat, ".githooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await git(feat, ["commit", "--quiet", "--allow-empty", "-m", "feat"]);

    expect((await stat(marker)).isFile()).toBe(true);

    const overlay = await discoverGitOverlay(await workspaceAt(base, repo), contextOf(base));

    expect(overlay.readOnlyDirs).toEqual(
      expect.arrayContaining([join(repo, ".githooks"), join(feat, ".githooks")]),
    );
  });

  it("refuses a sparse worktree's missing main config.worktree with the command that fixes it", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const worktree = join(base, "wt");
    const missing = join(repo, ".git", "config.worktree");

    await git(repo, ["worktree", "add", "--quiet", "-b", "wt", worktree]);
    await git(worktree, ["sparse-checkout", "init", "--cone"]);

    expect((await stat(join(repo, ".git", "worktrees", "wt", "config.worktree"))).isFile()).toBe(true);

    const refusal = await discoverGitOverlay(await workspaceAt(base, repo), contextOf(base)).catch(
      (error: unknown) => error as { message: string; hint: string },
    );

    expect(refusal).toMatchObject({
      message: expect.stringContaining(`git: ${missing} is missing; extensions.worktreeConfig`),
      hint: `create it empty with touch ${missing} (an empty file changes nothing for git)`,
    });

    await writeFile(missing, "");
    await git(repo, ["status", "--short"]);

    expect(
      (await discoverGitOverlay(await workspaceAt(base, repo), contextOf(base))).readOnlyFiles,
    ).toContain(missing);
  });

  it("follows an include git reads only on another branch into its nested include and hooksPath", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const release = join(repo, "release.inc");
    const nested = join(repo, "nested.inc");

    await writeFile(release, "[include]\n\tpath = nested.inc\n[core]\n\thooksPath = evilhooks\n");
    await git(repo, ["config", "includeIf.onbranch:release.path", "../release.inc"]);
    await git(repo, ["checkout", "--quiet", "-b", "release"]);

    expect((await gitRunner.run("git", ["config", "core.hooksPath"], { cwd: repo })).stdout.trim()).toBe(
      "evilhooks",
    );

    await git(repo, ["checkout", "--quiet", "-"]);

    await expect(discoverGitOverlay(await workspaceAt(base, repo), contextOf(base))).rejects.toThrow(
      `git: ${release} includes ${nested}, which does not exist`,
    );

    await writeFile(nested, "");

    const overlay = await discoverGitOverlay(await workspaceAt(base, repo), contextOf(base));

    expect(overlay.readOnlyFiles).toEqual(expect.arrayContaining([release, nested]));
    expect(overlay.readOnlyDirs).toContain(join(repo, "evilhooks"));
  });

  it("stops at an include cycle between files git does not read yet", async () => {
    const base = await createBase();
    const repo = await createRepo(base);

    await writeFile(join(repo, "a.inc"), "[include]\n\tpath = b.inc\n");
    await writeFile(join(repo, "b.inc"), "[include]\n\tpath = a.inc\n");
    await git(repo, ["config", "includeIf.onbranch:never.path", "../a.inc"]);

    const overlay = await discoverGitOverlay(await workspaceAt(base, repo), contextOf(base));

    expect(overlay.readOnlyFiles).toEqual(expect.arrayContaining([join(repo, "a.inc"), join(repo, "b.inc")]));
  });

  it("follows the includes of a submodule's own git config", async () => {
    const base = await createBase();
    const library = await createRepo(base, "library");
    const repo = await createRepo(base);
    const moduleConfig = join(repo, ".git", "modules", "lib", "config");

    await git(repo, ["submodule", "add", "--quiet", library, "lib"]);
    await git(repo, ["config", "--file", moduleConfig, "include.path", "../../../lib.inc"]);

    await expect(discoverGitOverlay(await workspaceAt(base, repo), contextOf(base))).rejects.toThrow(
      `git: ${moduleConfig} includes ${join(repo, "lib.inc")}, which does not exist`,
    );
  });

  it("leaves includes under another user's home and git's prefix outside the repository", async () => {
    const base = await createBase();
    const repo = await createRepo(base);

    await git(repo, ["config", "include.path", `~${userInfo().username}/pi-sandbox-no-such-file.inc`]);
    await git(repo, ["config", "--add", "include.path", "%(prefix)/pi-sandbox-no-such-file.inc"]);
    await git(repo, ["status", "--short"]);

    const overlay = await discoverGitOverlay(await workspaceAt(base, repo), contextOf(base));

    expect(overlay.readOnlyFiles.some((path) => path.includes("pi-sandbox-no-such-file"))).toBe(false);
  });

  it("runs git twice to discover and plan a plain repository and once more for the baseline", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const { recorder, calls } = recordingRunner();
    const workspace = await discoverAt(repo, recorder, join(base, "state", "git", "no-hooks"), {
      overlays: false,
    });

    await readyGitOverlay(workspace, contextOf(base, recorder));

    expect(calls).toEqual(["rev-parse", "config", "ls-files"]);
  });
});
