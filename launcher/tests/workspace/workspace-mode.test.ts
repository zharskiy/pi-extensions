import { chmod, lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessRunner, sha256Hex, stateLayout } from "../../shared/index.ts";
import {
  discoverWorkspace,
  findProtectedGitPaths,
  gitSessionEndNotices,
  protectedGitOverlay,
  recordGitBaseline,
  scanWorkspace,
  type Workspace,
  withGitPinLock,
  workspaceNotices,
  workspaceSelfBinds,
} from "../../workspace/index.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { tempDir } from "../support/temp-dir.ts";

const runner = createProcessRunner();

const NO_SYSTEM = { GIT_CONFIG_NOSYSTEM: "1" };

const git = async (cwd: string, args: string[]) => {
  const result = await runner.run(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd },
  );

  expect(result.code, result.stderr).toBe(0);
};

const createRoot = async () => realpath(await tempDir("workspace-mode"));

const createRepo = async (path: string) => {
  await mkdir(path, { recursive: true });

  await git(path, ["init", "--quiet"]);

  await git(path, ["commit", "--quiet", "--allow-empty", "-m", "init"]);

  return path;
};

const markRepo = (path: string) => mkdir(join(path, ".git"), { recursive: true });

const noHooksOf = (base: string) => join(base, "state", "git", "no-hooks");

const discover = (root: string) => discoverWorkspace(root, runner, noHooksOf(root));

const repoAt = (repoRoot: string): Workspace => ({
  cwd: repoRoot,
  repoRoot,
  gitDir: join(repoRoot, ".git"),
  gitCommonDir: join(repoRoot, ".git"),
  isGitRepo: true,
});

describe("the workspace scan", () => {
  it("lists repositories at depth 1 and 3 of a plain folder, sorted", async () => {
    const root = await createRoot();

    await createRepo(join(root, "x", "y", "deep"));

    await createRepo(join(root, "alpha"));

    const workspace = await discover(root);

    expect(workspace.nested?.map((repo) => repo.repoRoot)).toEqual([
      join(root, "alpha"),
      join(root, "x", "y", "deep"),
    ]);
    expect(workspace.nested?.[0]).toMatchObject({
      gitCommonDir: join(root, "alpha", ".git"),
      isGitRepo: true,
    });
  });

  it("finds repositories at any depth and in hidden folders, but not under node_modules or inside a .git", async () => {
    const root = await createRoot();

    await Promise.all(
      [
        join(root, "shallow"),
        join(root, "a", "b", "c", "d", "e", "f", "deep"),
        join(root, ".hidden", "repo"),
        join(root, "node_modules", "package"),
        join(root, "shallow", ".git", "modules", "planted"),
      ].map(markRepo),
    );

    expect(await scanWorkspace(root, "workspace")).toEqual({
      repos: [
        join(root, ".hidden", "repo"),
        join(root, "a", "b", "c", "d", "e", "f", "deep"),
        join(root, "shallow"),
      ],
      nodeProjects: [],
      truncated: false,
      unreadable: [],
    });
  });

  it("lists a repository inside a nested repository but not a submodule checkout", async () => {
    const root = await createRoot();
    const library = await createRepo(join(await createRoot(), "library"));
    const outer = await createRepo(join(root, "outer"));

    await git(outer, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", library, "lib"]);

    await createRepo(join(outer, "vendor", "inner"));

    expect((await discover(root)).nested?.map((repo) => repo.repoRoot)).toEqual([
      outer,
      join(outer, "vendor", "inner"),
    ]);
  });

  it("refuses a workspace with more directories than the search may visit", async () => {
    const root = await createRoot();
    const wide = join(root, "wide");

    await mkdir(wide);

    await Promise.all(Array.from({ length: 50_000 }, (_, index) => mkdir(join(wide, `d${index}`))));

    await expect(discover(root)).rejects.toMatchObject({
      message: `workspace: ${root} has more than 50000 directories to search for repositories, refusing`,
      hint: "start pi in a narrower folder",
    });
  }, 60_000);

  it("finds lockfile folders in a workspace and in a repository, skipping a linked node_modules", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "repo"));

    await Promise.all(
      [join(root, "app"), join(root, "linked"), join(repo, "web"), join(root, "app", "node_modules")].map(
        (dir) => mkdir(dir, { recursive: true }),
      ),
    );

    await Promise.all([
      writeFile(join(root, "app", "package-lock.json"), "{}"),
      writeFile(join(root, "linked", "yarn.lock"), ""),
      writeFile(join(repo, "web", "pnpm-lock.yaml"), ""),
      writeFile(join(repo, "bun.lockb"), ""),
    ]);

    await symlink(join(root, "app", "node_modules"), join(root, "linked", "node_modules"));

    expect((await discover(root)).nodeProjects).toEqual([join(root, "app"), repo, join(repo, "web")]);
    expect((await discoverWorkspace(repo, runner, noHooksOf(root))).nodeProjects).toEqual([
      repo,
      join(repo, "web"),
    ]);
  });

  it("adds package folders below a lockfile folder of the same repository, at most 256 per repository", async () => {
    const root = await createRoot();
    const mono = join(root, "mono");
    const packages = Array.from({ length: 257 }, (_, index) => join(mono, "packages", `p${index}`));
    const plain = [join(root, "loose"), join(mono, "node_modules", "dep"), join(mono, "nested", "pkg")];

    await Promise.all([...packages, ...plain].map((dir) => mkdir(dir, { recursive: true })));

    await markRepo(join(mono, "nested"));

    await Promise.all(
      [
        join(mono, "npm-shrinkwrap.json"),
        ...[...packages, ...plain].map((dir) => join(dir, "package.json")),
      ].map((file) => writeFile(file, "{}")),
    );

    const { nodeProjects } = await scanWorkspace(root, "workspace");

    expect(nodeProjects).toHaveLength(257);
    expect(nodeProjects[0]).toBe(mono);
    expect(nodeProjects.every((dir) => dir === mono || dir.startsWith(join(mono, "packages", "p")))).toBe(
      true,
    );
  });

  it("discovers a folder without repositories when git is not installed", async () => {
    const root = await createRoot();

    await mkdir(join(root, "notes"));

    const absent = createProcessRunner({ baseEnv: { PATH: join(root, "no-bin") } });

    expect(await discoverWorkspace(root, absent, noHooksOf(root))).toEqual({
      cwd: root,
      repoRoot: root,
      isGitRepo: false,
      nested: [],
      nodeProjects: [],
    });
  });

  it("refuses a folder without repositories when git is installed but fails", async () => {
    const root = await createRoot();
    const { runner: failing } = createFakeRunner(() => ({ code: 1, stderr: "git is broken\n" }));

    await expect(discoverWorkspace(root, failing, noHooksOf(root))).rejects.toThrow(
      `git: could not list the git configuration of ${root}: git is broken`,
    );
  });

  it("refuses a folder it cannot read, naming it", async () => {
    if (process.getuid?.() === 0) {
      return;
    }

    const root = await createRoot();
    const locked = join(root, "locked");

    await markRepo(join(locked, "hidden-repo"));

    await chmod(locked, 0o000);

    const strict = discover(root).finally(() => chmod(locked, 0o755));

    await expect(strict).rejects.toThrow(`workspace: ${locked} cannot be protected: cannot read it (EACCES)`);

    await chmod(locked, 0o000);

    const lenient = await discoverWorkspace(root, runner, noHooksOf(root), { lenient: true }).finally(() =>
      chmod(locked, 0o755),
    );

    expect(lenient.nested).toEqual([]);
  });

  it("skips the .pi folder, so agent worktrees are neither repositories nor node projects", async () => {
    const root = await createRoot();
    const agent = join(root, ".pi", "worktrees", "agent-1");
    const repoAgent = join(root, "repo", ".pi", "worktrees", "agent-2");

    await Promise.all([markRepo(agent), markRepo(join(root, "repo")), markRepo(repoAgent)]);

    await Promise.all([agent, repoAgent].map((dir) => writeFile(join(dir, "package-lock.json"), "{}")));

    expect(await scanWorkspace(root, "workspace")).toMatchObject({
      repos: [join(root, "repo")],
      nodeProjects: [],
    });
    expect((await scanWorkspace(join(root, "repo"), "git")).nodeProjects).toEqual([]);
  });

  it("collects no node projects when asked not to, still listing repositories", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "repo"));

    await writeFile(join(repo, "package-lock.json"), "{}");

    const lenient = await discoverWorkspace(root, runner, noHooksOf(root), {
      lenient: true,
      scanNodeProjects: false,
    });
    const inRepo = await discoverWorkspace(repo, runner, noHooksOf(root), { scanNodeProjects: false });

    expect(lenient.nested?.map((nested) => nested.repoRoot)).toEqual([repo]);
    expect(lenient.nodeProjects).toEqual([]);
    expect(inRepo.nodeProjects).toEqual([]);
  });

  it("drops every node project and says so when there are more than 512", async () => {
    const root = await createRoot();
    const apps = Array.from({ length: 513 }, (_, index) => join(root, `app${index}`));

    await Promise.all(apps.map((dir) => mkdir(dir)));

    await Promise.all(apps.map((dir) => writeFile(join(dir, "yarn.lock"), "")));

    const capped = { nodeProjects: [], nodeProjectsCapped: true };

    expect(await discover(root)).toMatchObject(capped);
    expect(await discoverWorkspace(root, runner, noHooksOf(root), { lenient: true })).toMatchObject(capped);
  });

  it("lists nested repositories without asking git when discovery is lenient", async () => {
    const root = await createRoot();
    const odd = join(root, "odd");

    await mkdir(odd);

    await writeFile(join(odd, ".git"), `gitdir: ${join(root, "missing")}\n`);

    const { runner: fake, calls } = createFakeRunner(() => ({ code: 1 }));

    expect(await discoverWorkspace(root, fake, noHooksOf(root), { lenient: true })).toEqual({
      cwd: root,
      repoRoot: root,
      isGitRepo: false,
      nested: [{ cwd: odd, repoRoot: odd, isGitRepo: true }],
      nodeProjects: [],
    });
    expect(calls).toEqual([]);
  });
});

describe("the nested repository checks", () => {
  it("refuses a nested repository whose .git is a symbolic link, naming it", async () => {
    const root = await createRoot();
    const source = await createRepo(join(root, "source"));
    const linked = join(root, "linked");

    await mkdir(linked);

    await symlink(join(source, ".git"), join(linked, ".git"));

    await expect(discover(root)).rejects.toMatchObject({
      message: `workspace: ${linked} cannot be protected: git: ${join(linked, ".git")} is a symbolic link`,
      hint: "fix or move that repository, or start pi inside it",
    });
  });

  it("refuses a nested repository git does not open, naming it", async () => {
    const root = await createRoot();
    const odd = join(root, "odd");
    const target = join(root, "target");

    await Promise.all([mkdir(odd), mkdir(target)]);

    await writeFile(join(odd, ".git"), `gitdir: ${target}\n`);

    await expect(discover(root)).rejects.toThrow(
      `workspace: ${odd} cannot be protected: git: ${join(odd, ".git")} leads to ${target}, but git does not open it`,
    );
  });

  it("refuses a nested worktree whose git dir lies outside the workspace", async () => {
    const root = await createRoot();
    const main = await createRepo(join(await createRoot(), "main"));
    const worktree = join(root, "linked");

    await git(main, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

    await expect(discover(root)).rejects.toMatchObject({
      message: `workspace: ${worktree} uses a git dir outside ${root}`,
      hint: "start pi inside it",
    });
  });

  it("refuses a workspace with more than 128 repositories", async () => {
    const root = await createRoot();

    await Promise.all(Array.from({ length: 129 }, (_, index) => markRepo(join(root, `repo${index}`))));

    await expect(discover(root)).rejects.toMatchObject({
      message: `workspace: ${root} holds 129 repositories, more than the 128 the launcher protects`,
      hint: "start pi in a narrower folder",
    });
  });
});

describe("the git configuration around a workspace", () => {
  const configured = async (hooksPath: string) => {
    const root = await createRoot();
    const home = await realpath(await tempDir("workspace-home"));
    const env = { ...process.env, ...NO_SYSTEM, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };

    await writeFile(join(home, ".gitconfig"), `[core]\n\thooksPath = ${join(root, hooksPath)}\n`);

    return { root, home, env, runner: createProcessRunner({ baseEnv: env }) };
  };

  const protectContext = (setup: Awaited<ReturnType<typeof configured>>, workspace: Workspace) => ({
    runner: setup.runner,
    home: setup.home,
    env: setup.env,
    emptyHooksDir: noHooksOf(setup.root),
    engineSockets: [],
    workspace,
  });

  it("refuses a global hooksPath inside the workspace but outside its repositories", async () => {
    const setup = await configured("hooks");
    const repo = await createRepo(join(setup.root, "repo"));
    const workspace = await discoverWorkspace(setup.root, setup.runner, noHooksOf(setup.root));

    await mkdir(join(setup.root, "hooks"));

    await expect(
      findProtectedGitPaths(repoAt(repo), join(repo, ".git"), protectContext(setup, workspace)),
    ).rejects.toThrow(
      `workspace: git configuration ${join(setup.root, "hooks")} lies inside the workspace, refusing`,
    );
  });

  it("makes a global hooksPath inside another nested repository read-only, binding the folders above it", async () => {
    const setup = await configured(join("a", "tools", "hooks"));
    const first = await createRepo(join(setup.root, "a"));
    const second = await createRepo(join(setup.root, "b"));
    const workspace = await discoverWorkspace(setup.root, setup.runner, noHooksOf(setup.root));
    const hooks = join(first, "tools", "hooks");
    const context = protectContext(setup, workspace);

    await mkdir(hooks, { recursive: true });

    const paths = await findProtectedGitPaths(repoAt(second), join(second, ".git"), context);
    const overlay = await protectedGitOverlay(repoAt(second), paths, () => undefined);

    expect(overlay.readOnlyDirs).toContain(hooks);
    expect(overlay.selfBinds).toEqual(expect.arrayContaining([first, join(first, "tools")]));
  });

  it("refuses a global git config file that lies inside a workspace with repositories", async () => {
    const root = await createRoot();

    await createRepo(join(root, "repo"));

    const home = join(root, "home");
    const env = { ...process.env, ...NO_SYSTEM, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };

    await mkdir(home);

    await writeFile(join(home, ".gitconfig"), "[user]\n\tname = test\n");

    await expect(
      discoverWorkspace(root, createProcessRunner({ baseEnv: env }), noHooksOf(root)),
    ).rejects.toThrow(
      `workspace: git configuration ${join(home, ".gitconfig")} lies inside the workspace, refusing`,
    );
  });
  const plainContext = (root: string, workspace?: Workspace) => ({
    runner,
    home: homedir(),
    env: process.env,
    emptyHooksDir: noHooksOf(root),
    engineSockets: [],
    ...(workspace === undefined ? {} : { workspace }),
  });

  it("refuses a repository config that includes a file from the workspace outside every repository", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "a"));

    await writeFile(join(root, "shared.gitconfig"), "[user]\n\tname = test\n");

    await git(repo, ["config", "include.path", "../../shared.gitconfig"]);

    await expect(discover(root)).rejects.toThrow(
      `workspace: git configuration ${join(root, "shared.gitconfig")} lies inside the workspace, refusing`,
    );
  });

  it("binds read-only a file a repository config includes from a sibling repository", async () => {
    const root = await createRoot();
    const first = await createRepo(join(root, "a"));
    const second = await createRepo(join(root, "b"));
    const team = join(second, "team.gitconfig");

    await writeFile(team, "[user]\n\tname = test\n");

    await git(first, ["config", "include.path", "../../b/team.gitconfig"]);

    const workspace = await discover(root);
    const paths = await findProtectedGitPaths(
      repoAt(first),
      join(first, ".git"),
      plainContext(root, workspace),
    );
    const overlay = await protectedGitOverlay(repoAt(first), paths, () => undefined);

    expect(overlay.readOnlyFiles).toContain(team);
    expect(overlay.selfBinds).toContain(second);
  });

  it("refuses a global includeIf that only matches inside a nested repository and points outside every repository", async () => {
    const root = await createRoot();
    const home = await realpath(await tempDir("workspace-home"));
    const env = { ...process.env, ...NO_SYSTEM, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
    const notes = join(root, "notes", "a.gitconfig");

    await createRepo(join(root, "a"));

    await mkdir(join(root, "notes"));

    await writeFile(notes, "[user]\n\tname = test\n");

    await writeFile(
      join(home, ".gitconfig"),
      `[includeIf "gitdir:${join(root, "a")}/"]\n\tpath = ${notes}\n`,
    );

    await expect(
      discoverWorkspace(root, createProcessRunner({ baseEnv: env }), noHooksOf(root)),
    ).rejects.toThrow(`workspace: git configuration ${notes} lies inside the workspace, refusing`);
  });

  it("binds read-only a file a single repository's config includes from its working tree", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "repo"));
    const team = join(repo, "team.gitconfig");

    await writeFile(team, "[user]\n\tname = test\n");

    await git(repo, ["config", "include.path", "../team.gitconfig"]);

    const paths = await findProtectedGitPaths(repoAt(repo), join(repo, ".git"), plainContext(root));
    const overlay = await protectedGitOverlay(repoAt(repo), paths, () => undefined);

    expect(overlay.readOnlyFiles).toContain(team);
  });
});

describe("the workspace mounts and notices", () => {
  it("self-binds every nested repository and each folder above it, shallowest first", () => {
    const workspace: Workspace = {
      cwd: "/w",
      repoRoot: "/w",
      isGitRepo: false,
      nested: [repoAt("/w/x/y/deep"), repoAt("/w/alpha"), repoAt("/w/x/other")],
    };

    expect(workspaceSelfBinds(workspace)).toEqual([
      "/w/alpha",
      "/w/x",
      "/w/x/other",
      "/w/x/y",
      "/w/x/y/deep",
    ]);
  });

  it("names how many repositories are protected", () => {
    const workspace: Workspace = {
      cwd: "/w",
      repoRoot: "/w",
      isGitRepo: false,
      nested: [repoAt("/w/a"), repoAt("/w/b")],
    };

    expect(workspaceNotices(workspace)).toEqual([
      "pi-sandbox: workspace with 2 repositories, git metadata protected",
    ]);
    expect(workspaceNotices({ ...workspace, nested: [repoAt("/w/a")] })).toEqual([
      "pi-sandbox: workspace with 1 repository, git metadata protected",
    ]);
    expect(workspaceNotices({ ...workspace, nested: [] })).toEqual([]);
    expect(workspaceNotices(repoAt("/w/a"))).toEqual([]);
  });
});

describe("the workspace git locks and session end", () => {
  it("holds the pin lock of every nested repository while the action runs", async () => {
    const root = await createRoot();
    const stateDir = join(root, "state");
    const workspace: Workspace = {
      cwd: root,
      repoRoot: root,
      isGitRepo: false,
      nested: [repoAt(join(root, "b")), repoAt(join(root, "a")), repoAt(join(root, "a"))],
    };
    const locks = [join(root, "a", ".git"), join(root, "b", ".git")].map((dir) =>
      stateLayout(stateDir).gitPinLock(sha256Hex(dir)),
    );
    const held = await withGitPinLock(stateDir, workspace, () =>
      Promise.all(locks.map((lock) => lstat(lock).then((info) => info.isFile()))),
    );

    expect(held).toEqual([true, true]);
  });

  it("reports a .git created in the workspace and inside a nested repository during the session", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "repo"));
    const workspace = await discover(root);
    const context = { runner, stateDir: join(root, "state") };
    const asked: string[] = [];

    await recordGitBaseline(workspace, context);

    await Promise.all([markRepo(join(root, "planted")), markRepo(join(repo, "sub"))]);

    const notices = await gitSessionEndNotices(workspace, context, async (gitCommonDir) => {
      asked.push(gitCommonDir);

      return false;
    });

    expect(notices).toEqual([
      `git: the sandbox created ${join(root, "planted", ".git")}; review it before running host git tools in this repository`,
      `git: the sandbox created ${join(repo, "sub", ".git")}; review it before running host git tools in this repository`,
    ]);
    expect(asked).toEqual([join(repo, ".git")]);
  });
});
