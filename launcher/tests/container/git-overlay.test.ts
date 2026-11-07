import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendCapabilities, MountSpec } from "../../backend/index.ts";
import {
  buildContainerSpec,
  discoverGitOverlay,
  type GitGuardContext,
  type GitOverlay,
  gitDirInUseElsewhere,
  gitLaunchNotices,
  gitSessionEndNotices,
  LABELS,
  readyGitOverlay,
} from "../../container/index.ts";
import { createProcessRunner } from "../../shared/index.ts";
import { discoverWorkspace, type Workspace } from "../../workspace/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const runner = createProcessRunner();

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const capabilities: BackendCapabilities = { singleFileMount: true, sshAgent: false, internalNetwork: true };

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

const busy = async () => true;

const workspaceAt = (base: string, cwd: string) =>
  discoverWorkspace(cwd, runner, join(base, "state", "git", "no-hooks"));

const specOf = (base: string, workspace: Workspace, gitOverlay: GitOverlay, singleFileMount = true) =>
  buildContainerSpec({
    workspace,
    config: sandboxConfig(),
    image: { reference: "pi-sandbox:local", digest: "sha256:one", id: "sha256:image-one" },
    hostEnv: { USER: "dev", HOME: join(base, "home") },
    hostUid: 501,
    hostGid: 20,
    platform: "darwin",
    capabilities: { ...capabilities, singleFileMount },
    stateDir: join(base, "state"),
    gitOverlay,
    launcherVersion: "0.4.0",
    configHash: "cfg",
  });

const gitMountsOf = (spec: { mounts: MountSpec[] }, repo: string) =>
  spec.mounts.filter((mount) => mount.kind === "bind" && mount.target.startsWith(repo));

const describeMount = (base: string, mount: MountSpec) => ({
  target: mount.target,
  readOnly: mount.readOnly,
  snapshot: mount.source.startsWith(join(base, "state", "git")),
});

describe("the git dir in the container", () => {
  it("binds .git onto itself and its config, hooks and commondir pin read-only from snapshots", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const spec = specOf(base, workspace, await discoverGitOverlay(workspace, contextOf(base)));

    expect(gitMountsOf(spec, repo).map((mount) => describeMount(base, mount))).toEqual([
      { target: repo, readOnly: false, snapshot: false },
      { target: join(repo, ".git"), readOnly: false, snapshot: false },
      { target: join(repo, ".git", "hooks"), readOnly: true, snapshot: true },
      { target: join(repo, ".git", "config"), readOnly: true, snapshot: true },
      { target: join(repo, ".git", "commondir"), readOnly: true, snapshot: true },
    ]);
    expect(spec.labels["pi-sandbox.git-protection"]).toBeDefined();
  });

  it("writes the pin and the snapshots before a start, with hooks copied", async () => {
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
    expect(await readFile(sourceAt(join(repo, ".git", "commondir")), "utf8")).toBe(".\n");
    expect(await readFile(sourceAt(join(repo, ".git", "config")), "utf8")).toBe(
      await readFile(join(repo, ".git", "config"), "utf8"),
    );
    expect(await readFile(join(hooks, "pre-commit"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(((await stat(join(hooks, "pre-commit"))).mode & 0o111) !== 0).toBe(true);
  });

  it("refuses a symlinked hook file before a start and never copies its target", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const secret = join(base, "home", "secret");
    const hook = join(repo, ".git", "hooks", "post-checkout");
    const workspace = await workspaceAt(base, repo);

    await writeFile(secret, "secret\n");

    await symlink(secret, hook);

    await expect(readyGitOverlay(workspace, contextOf(base))).rejects.toThrow(
      `git: ${hook} is a symbolic link; symlinked hooks are not supported inside the sandbox`,
    );
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

    expect(mounts).toEqual(
      expect.arrayContaining([
        { target: worktree, readOnly: false, snapshot: false },
        { target: join(repo, ".git"), readOnly: false, snapshot: false },
        { target: join(repo, ".git", "worktrees"), readOnly: false, snapshot: false },
        { target: gitDir, readOnly: false, snapshot: false },
        { target: join(worktree, ".git"), readOnly: true, snapshot: true },
        { target: join(gitDir, "commondir"), readOnly: true, snapshot: true },
        { target: join(gitDir, "gitdir"), readOnly: true, snapshot: true },
        { target: join(repo, ".git", "commondir"), readOnly: true, snapshot: true },
        { target: join(repo, ".git", "config"), readOnly: true, snapshot: true },
      ]),
    );
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

  it("binds no git files on a backend without single-file mounts but keeps the dir snapshots", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const spec = specOf(base, workspace, await discoverGitOverlay(workspace, contextOf(base)), false);

    expect(gitMountsOf(spec, repo).map((mount) => mount.target)).toEqual([
      repo,
      join(repo, ".git"),
      join(repo, ".git", "hooks"),
    ]);
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

  it("removes the pin after the session and reports a commondir the sandbox rewrote", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const pin = join(repo, ".git", "commondir");

    await readyGitOverlay(workspace, contextOf(base));

    expect(await gitSessionEndNotices(workspace, contextOf(base), idle)).toEqual([]);
    expect(await lstat(pin).catch(() => undefined)).toBeUndefined();

    await readyGitOverlay(workspace, contextOf(base));

    await writeFile(pin, "../.x\n");

    expect(await gitSessionEndNotices(workspace, contextOf(base), idle)).toEqual([
      `git: ${pin} was changed inside the sandbox; the launcher removed it`,
    ]);
    expect(await lstat(pin).catch(() => undefined)).toBeUndefined();
  });

  it("keeps the pins while another running sandbox shares the git dir", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);

    await readyGitOverlay(workspace, contextOf(base));

    expect(await gitSessionEndNotices(workspace, contextOf(base), busy)).toEqual([]);
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
      await gitSessionEndNotices(workspace, contextOf(base), () =>
        gitDirInUseElsewhere(fake.backend, workspace),
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

    const notices = await gitSessionEndNotices(workspace, contextOf(base), idle);

    expect(notices).toEqual([
      `git: the sandbox created ${join(repo, "vendor", "nested", ".git")}; review it before running host git tools in this repository`,
      `git: the sandbox added the gitlink ${join(repo, "vendor", "nested")} (a nested repository); review it before running host git tools in this repository`,
    ]);
  });

  it("removes a commondir the sandbox planted in a module git dir", async () => {
    const base = await createBase();
    const repo = await createRepo(base);
    const workspace = await workspaceAt(base, repo);
    const module = join(repo, ".git", "modules", "m");

    await readyGitOverlay(workspace, contextOf(base));

    await mkdir(module, { recursive: true });
    await writeFile(join(module, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(module, "commondir"), "../../../.x\n");

    const notices = await gitSessionEndNotices(workspace, contextOf(base), idle);

    expect(notices).toEqual([
      `git: ${join(module, "commondir")} was changed inside the sandbox; the launcher removed it`,
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

    expect(await gitSessionEndNotices(workspace, contextOf(base), idle)).toEqual([
      `git: ${planted} is a symbolic link`,
    ]);
    expect(await lstat(join(repo, ".git", "commondir")).catch(() => undefined)).toBeUndefined();
  });
});
