import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MountSpec } from "../../backend/index.ts";
import {
  buildContainerSpec,
  type GitGuardContext,
  type GitOverlay,
  gitDirInUseElsewhere,
  gitLaunchEndNotices,
  gitLaunchNotices,
  LABELS,
  planGitOverlay,
} from "../../container/index.ts";
import { createProcessRunner, readPins, sha256Hex, stateLayout, writePins } from "../../shared/index.ts";
import { discoverWorkspace, unpinRecorded, type Workspace } from "../../workspace/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const runner = createProcessRunner();

const discoverGitOverlay = async (workspace: Workspace, context: GitGuardContext) =>
  (await planGitOverlay(workspace, context)).overlay;

const readyGitOverlay = async (workspace: Workspace, context: GitGuardContext) =>
  (await planGitOverlay(workspace, context)).ready();

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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
      "-c",
      "advice.addEmbeddedRepo=false",
      ...args,
    ],
    { cwd },
  );

  expect(result.code, result.stderr).toBe(0);
};

const createBase = async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-git-")));

  created.push(base);

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
  discoverWorkspace(cwd, runner, join(base, "state", "git", "no-hooks"));

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
    const workspace = await workspaceAt(base, repo);

    await mkdir(join(repo, "tools", "hooks"), { recursive: true });
    await mkdir(join(base, "outside-hooks"));
    await symlink(join(repo, "tools"), join(repo, "linked"));

    await git(repo, ["config", "core.hooksPath", "tools/hooks"]);

    expect((await discoverGitOverlay(workspace, contextOf(base))).readOnlyDirs).toContain(
      join(repo, "tools", "hooks"),
    );

    await git(repo, ["config", "core.hooksPath", join(base, "outside-hooks")]);

    expect((await discoverGitOverlay(workspace, contextOf(base))).readOnlyDirs).toEqual([
      join(repo, ".git", "hooks"),
    ]);

    await git(repo, ["config", "core.hooksPath", "linked/hooks"]);

    await expect(discoverGitOverlay(workspace, contextOf(base))).rejects.toThrow(
      "(core.hooksPath) goes through a symbolic link",
    );
  });

  it("creates a missing hooks dir and binds its parents so the sandbox cannot rename them away", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);

    await rm(join(repo, ".git", "hooks"), { recursive: true });

    await git(repo, ["config", "core.hooksPath", ".husky/_"]);

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
    const workspace = await workspaceAt(base, repo);

    await git(repo, ["config", "core.hooksPath", ".husky/_"]);

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
