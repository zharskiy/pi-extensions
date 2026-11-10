import { chmod, lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessRunner, sha256Hex, stateLayout } from "../../shared/index.ts";
import {
  discoverWorkspace,
  findProtectedGitPaths,
  gitLaunchEndNotices,
  mountedGitDirs,
  protectedGitOverlay,
  recordGitBaseline,
  type Workspace,
  withGitPinLock,
  workspaceFolder,
  workspaceNotices,
  workspaceSelfBinds,
} from "../../workspace/index.ts";
import { scanWorkspace } from "../../workspace/workspace-scan.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { git, gitEnv, gitHome, gitRunner } from "../support/git.ts";
import { tempDir } from "../support/temp-dir.ts";

const discoverAt = async (
  cwd: string,
  ...rest: Parameters<typeof discoverWorkspace> extends [unknown, ...infer R] ? R : never
) => discoverWorkspace(await workspaceFolder(cwd), ...rest);

const runner = gitRunner;

const createRoot = async () => realpath(await tempDir("workspace-mode"));

const createRepo = async (path: string) => {
  await mkdir(path, { recursive: true });

  await git(path, ["init", "--quiet"]);

  await git(path, ["commit", "--quiet", "--allow-empty", "-m", "init"]);

  return path;
};

const markRepo = (path: string) => mkdir(join(path, ".git"), { recursive: true });

const noHooksOf = (base: string) => join(base, "state", "git", "no-hooks");

const discover = (root: string, scanBudget?: number) =>
  discoverAt(root, runner, noHooksOf(root), { scanBudget });

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
      bare: [],
      overlays: [],
      variants: [],
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

    await Promise.all(
      Array.from({ length: 5 }, (_, index) => mkdir(join(root, "wide", `d${index}`), { recursive: true })),
    );

    await expect(discover(root, 5)).rejects.toMatchObject({
      message: `workspace: ${root} has more than 5 directories to search for repositories, refusing`,
      hint: "start pi in a narrower folder",
    });
  });

  it("overlays the build output each marker names, skipping a marker folder whose output is a file", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "repo"));
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

    expect((await discoverAt(repo, runner, noHooksOf(root))).overlays).toEqual([
      join(repo, ".gradle"),
      join(repo, "api", ".venv"),
      join(repo, "app", ".gradle"),
      join(repo, "cli", "target"),
    ]);
  });

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

    expect((await discover(root)).overlays).toEqual(
      [join(root, "app"), repo, join(repo, "web")].map((dir) => join(dir, "node_modules")),
    );
    expect((await discoverAt(repo, runner, noHooksOf(root))).overlays).toEqual(
      [repo, join(repo, "web")].map((dir) => join(dir, "node_modules")),
    );
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

    const { overlays } = await scanWorkspace(root, "workspace");

    expect(overlays).toHaveLength(257);
    expect(overlays[0]).toBe(join(mono, "node_modules"));
    expect(
      overlays.every(
        (dir) => dir === join(mono, "node_modules") || dir.startsWith(join(mono, "packages", "p")),
      ),
    ).toBe(true);
  });

  it("discovers a folder without repositories when git is not installed", async () => {
    const root = await createRoot();

    await mkdir(join(root, "notes"));

    const absent = createProcessRunner({ baseEnv: { PATH: join(root, "no-bin") } });

    expect(await discoverAt(root, absent, noHooksOf(root))).toEqual({
      cwd: root,
      repoRoot: root,
      isGitRepo: false,
      nested: [],
      overlays: [],
    });
  });

  it("refuses a folder without repositories when git is installed but fails", async () => {
    const root = await createRoot();
    const { runner: failing } = createFakeRunner(() => ({ code: 1, stderr: "git is broken\n" }));

    await expect(discoverAt(root, failing, noHooksOf(root))).rejects.toThrow(
      `git: could not list the git configuration of ${root}: git is broken`,
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "masks a folder it cannot read, names it, and refuses an unreadable cwd",
    async () => {
      const root = await createRoot();
      const locked = join(root, "locked");

      await markRepo(join(locked, "hidden-repo"));

      await chmod(locked, 0o000);

      const strict = await discover(root).finally(() => chmod(locked, 0o755));

      expect(strict).toMatchObject({ nested: [], masked: [locked] });
      expect(await lstat(noHooksOf(root)).catch(() => undefined)).toBeUndefined();
      expect(workspaceNotices(strict)).toEqual([
        `pi-sandbox: cannot read ${locked}; the sandbox sees them as empty read-only folders, and git there shows the files a repository tracks in them as deleted`,
      ]);

      await chmod(locked, 0o000);

      const lenient = await discoverAt(root, runner, noHooksOf(root), { lenient: true }).finally(() =>
        chmod(locked, 0o755),
      );

      expect(lenient.nested).toEqual([]);
      expect(lenient.masked).toBeUndefined();

      await chmod(locked, 0o000);

      await expect(discover(locked).finally(() => chmod(locked, 0o755))).rejects.toMatchObject({
        message: `workspace: cannot read ${locked} (EACCES), refusing`,
        hint: "make it readable (chmod u+rx) or start pi in another folder",
      });
    },
  );

  it("caps a notice list at 20 paths", () => {
    const masked = Array.from({ length: 22 }, (_, index) => `/w/d${index}`);
    const [notice] = workspaceNotices({ cwd: "/w", repoRoot: "/w", isGitRepo: false, masked });

    expect(notice).toContain("/w/d19 and 2 more;");
    expect(notice).not.toContain("/w/d20");
  });

  it("does not search build output an overlay hides, unless overlays are off or discovery is lenient", async () => {
    const root = await createRoot();
    const venv = join(root, "api", ".venv");
    const target = join(root, "cli", "target");

    await Promise.all(
      [join(venv, "src", "dep"), join(target, "vendored"), join(root, "plain", ".venv", "x")].map(markRepo),
    );

    await Promise.all([
      writeFile(join(root, "api", "uv.lock"), ""),
      writeFile(join(root, "cli", "Cargo.lock"), ""),
    ]);

    const all = [join(venv, "src", "dep"), join(target, "vendored"), join(root, "plain", ".venv", "x")];

    expect(await scanWorkspace(root, "workspace", { skipOverlays: true })).toMatchObject({
      repos: [join(root, "plain", ".venv", "x")],
      overlays: [venv, target],
    });
    expect((await scanWorkspace(root, "workspace")).repos).toEqual(all);
    expect((await scanWorkspace(root, "workspace", { skipOverlays: true, overlays: false })).repos).toEqual(
      all,
    );
    expect(
      (await discoverAt(root, runner, noHooksOf(root), { lenient: true })).nested?.map(
        (repo) => repo.repoRoot,
      ),
    ).toEqual(all);
  });

  it("fits a folder with large build output into the search budget when overlays hide it", async () => {
    const root = await createRoot();
    const venv = join(root, "app", ".venv");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) => mkdir(join(venv, `pkg${index}`), { recursive: true })),
    );

    await writeFile(join(root, "app", "uv.lock"), "");

    await expect(
      discoverAt(root, runner, noHooksOf(root), { scanBudget: 6, overlays: false }),
    ).rejects.toThrow("has more than 6 directories");
    expect(await discover(root, 6)).toMatchObject({ nested: [], overlays: [venv] });
  });

  it("searches build output again when more than 512 overlays turn every overlay off", async () => {
    const root = await createRoot();
    const apps = Array.from({ length: 513 }, (_, index) => join(root, `app${index}`));

    await Promise.all(apps.map((dir) => mkdir(join(dir, ".venv"), { recursive: true })));

    await Promise.all(apps.map((dir) => writeFile(join(dir, "uv.lock"), "")));

    await createRepo(join(root, "app0", ".venv", "dep"));

    const workspace = await discover(root);

    expect(workspace).toMatchObject({ overlays: [], overlaysCapped: true });
    expect(workspace.nested?.map((nested) => nested.repoRoot)).toEqual([join(root, "app0", ".venv", "dep")]);
  });

  it("skips the .pi folder, so agent worktrees are neither repositories nor overlays", async () => {
    const root = await createRoot();
    const agent = join(root, ".pi", "worktrees", "agent-1");
    const repoAgent = join(root, "repo", ".pi", "worktrees", "agent-2");

    await Promise.all([markRepo(agent), markRepo(join(root, "repo")), markRepo(repoAgent)]);

    await Promise.all([agent, repoAgent].map((dir) => writeFile(join(dir, "package-lock.json"), "{}")));

    expect(await scanWorkspace(root, "workspace")).toMatchObject({
      repos: [join(root, "repo")],
      overlays: [],
    });
    expect((await scanWorkspace(join(root, "repo"), "git")).overlays).toEqual([]);
  });

  it("collects no overlays when asked not to, still listing repositories", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "repo"));

    await writeFile(join(repo, "package-lock.json"), "{}");

    const lenient = await discoverAt(root, runner, noHooksOf(root), {
      lenient: true,
      overlays: false,
    });
    const inRepo = await discoverAt(repo, runner, noHooksOf(root), { overlays: false });

    expect(lenient.nested?.map((nested) => nested.repoRoot)).toEqual([repo]);
    expect(lenient.overlays).toEqual([]);
    expect(inRepo.overlays).toEqual([]);
  });

  it("drops every overlay and says so when there are more than 512", async () => {
    const root = await createRoot();
    const apps = Array.from({ length: 513 }, (_, index) => join(root, `app${index}`));

    await Promise.all(apps.map((dir) => mkdir(dir)));

    await Promise.all(apps.map((dir) => writeFile(join(dir, "yarn.lock"), "")));

    const capped = { overlays: [], overlaysCapped: true };

    expect(await discover(root)).toMatchObject(capped);
    expect(await discoverAt(root, runner, noHooksOf(root), { lenient: true })).toMatchObject(capped);
  });

  it("lists nested repositories without asking git when discovery is lenient", async () => {
    const root = await createRoot();
    const odd = join(root, "odd");

    await mkdir(odd);

    await writeFile(join(odd, ".git"), `gitdir: ${join(root, "missing")}\n`);

    const { runner: fake, calls } = createFakeRunner(() => ({ code: 1 }));

    expect(await discoverAt(root, fake, noHooksOf(root), { lenient: true })).toEqual({
      cwd: root,
      repoRoot: root,
      isGitRepo: false,
      nested: [{ cwd: odd, repoRoot: odd, isGitRepo: true }],
      overlays: [],
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

  it("leaves a nested checkout whose git dir lies outside the folder as plain files, without asking git about it", async () => {
    const root = await createRoot();
    const main = await createRepo(join(await createRoot(), "main"));
    const worktree = join(root, "linked");
    const separate = join(root, "separate");
    const store = join(await createRoot(), "separate.git");
    const cwds: string[] = [];
    const recorder = {
      ...runner,
      run: (file: string, args: string[], options?: Parameters<typeof runner.run>[2]) => {
        cwds.push(String(options?.cwd ?? ""));

        return runner.run(file, args, options);
      },
    };

    await git(main, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

    await git(root, ["init", "--quiet", `--separate-git-dir=${store}`, separate]);

    const workspace = await discoverAt(root, recorder, noHooksOf(root));

    expect(workspace.nested).toEqual([]);
    expect(workspace.detached).toEqual([
      { repoRoot: worktree, missing: false },
      { repoRoot: separate, missing: false },
    ]);
    expect(mountedGitDirs(workspace)).toEqual([root]);
    expect(cwds).toEqual([root]);
    expect(workspaceNotices(workspace)).toEqual([
      `pi-sandbox: ${worktree}, ${separate}: the git dir lies outside this folder, so git does not work there in the sandbox; start pi inside the checkout to use git there`,
    ]);
  });

  it("refuses a nested checkout that reaches an outside git dir through a link inside the folder", async () => {
    const root = await createRoot();
    const main = await createRepo(join(await createRoot(), "main"));
    const checkout = join(root, "checkout");

    await git(main, ["worktree", "add", "--quiet", "-b", "feature", checkout]);

    await symlink(join(main, ".git", "worktrees"), join(root, "trees"));

    await writeFile(join(checkout, ".git"), `gitdir: ${join(root, "trees", "checkout")}\n`);

    await expect(discover(root)).rejects.toMatchObject({
      message: `workspace: ${checkout} uses a git dir outside ${root}`,
      hint: "start pi inside it",
    });
  });

  it("leaves a nested .git file whose git dir is gone outside the folder as a plain folder, with a notice", async () => {
    const root = await createRoot();
    const stale = join(root, "stale");
    const gone = join(await createRoot(), "main", ".git", "worktrees", "stale");

    await mkdir(stale);

    await writeFile(join(stale, ".git"), `gitdir: ${gone}\n`);

    const workspace = await discover(root);

    expect(workspace.detached).toEqual([{ repoRoot: stale, missing: true }]);
    expect(workspaceNotices(workspace)).toEqual([
      `pi-sandbox: ${stale}: .git points at a git dir that no longer exists, so the sandbox sees a plain folder; delete the .git file, or run git worktree prune in the repository that owned it`,
    ]);
  });

  it("refuses a nested .git file whose missing git dir lies inside the folder, where the sandbox could create it", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "repo"));
    const stale = join(root, "stale");
    const gone = join(repo, ".git", "worktrees", "stale");

    await mkdir(stale);

    await writeFile(join(stale, ".git"), `gitdir: ${gone}\n`);

    await expect(discover(root)).rejects.toMatchObject({
      message: `workspace: ${join(stale, ".git")} points at ${gone}, which does not exist; the sandbox could create it and make ${stale} a repository with its own hooks, refusing`,
      hint: `delete ${join(stale, ".git")}, or run git worktree repair or git worktree prune in the repository that owns ${gone}`,
    });
  });

  it("follows a link in a .git pointer the way git does, refusing a missing git dir it lands inside the folder", async () => {
    const root = await createRoot();
    const checkout = join(root, "B");
    const store = join(root, "deep", "store");

    await mkdir(join(root, "deep", "d1", "d2", "d3"), { recursive: true });
    await mkdir(checkout);
    await symlink(join(root, "deep", "d1", "d2", "d3"), join(checkout, "sym"));
    await writeFile(join(checkout, ".git"), "gitdir: sym/../../../store\n");

    await expect(discover(root)).rejects.toThrow(
      `workspace: ${join(checkout, ".git")} points at ${store}, which does not exist; the sandbox could create it`,
    );

    await git(root, ["init", "--quiet", "--bare", store]);

    await expect(discover(root)).rejects.toThrow(`workspace: ${checkout} cannot be protected`);
  });

  it("counts a pointer through a link inside the folder as inside, even when the link leads outside", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const checkout = join(root, "B");

    await mkdir(checkout);
    await symlink(outside, join(checkout, "sym"));
    await writeFile(join(checkout, ".git"), "gitdir: sym/store\n");

    await expect(discover(root)).rejects.toThrow(
      `workspace: ${join(checkout, ".git")} points at ${join(outside, "store")}, which does not exist`,
    );
  });

  it("keeps a nested worktree whose .git file holds a plain relative pointer", async () => {
    const root = await createRoot();
    const main = await createRepo(join(root, "main"));
    const worktree = join(root, "wt");

    await git(main, ["worktree", "add", "--quiet", "-b", "feature", worktree]);
    await writeFile(join(worktree, ".git"), "gitdir: ../main/.git/worktrees/wt\n");

    const workspace = await discover(root);

    expect(workspace.detached).toBeUndefined();
    expect(workspace.nested).toEqual([
      expect.objectContaining({ repoRoot: main }),
      expect.objectContaining({ repoRoot: worktree, gitCommonDir: join(main, ".git") }),
    ]);
  });

  it("refuses a letter-case variant of .git in a workspace and at a repository root, and lists it leniently", async () => {
    const root = await createRoot();
    const variant = join(root, "A", ".GIT");
    const refusal = (path: string) => ({
      message: `workspace: ${path} is a letter-case variant of .git, which git opens as a repository on this volume, refusing`,
      hint: "rename it to .git or remove it",
    });

    await mkdir(variant, { recursive: true });

    await expect(discover(root)).rejects.toMatchObject(refusal(variant));
    expect(
      (await discoverAt(root, runner, noHooksOf(root), { lenient: true })).nested?.map(
        (repo) => repo.repoRoot,
      ),
    ).toEqual([join(root, "A")]);
    await expect(discover(join(root, "A"))).rejects.toMatchObject(refusal(variant));
  });

  it("refuses a stale .git at the cwd itself, as a single repository", async () => {
    const root = await createRoot();
    const gone = join(root, "missing");

    await writeFile(join(root, ".git"), `gitdir: ${gone}\n`);

    await expect(discover(root)).rejects.toThrow(
      `git: ${join(root, ".git")} points at ${gone}, which is not a directory`,
    );
  });

  it("still refuses a nested .git file whose target exists but is no git dir, or is no gitdir pointer", async () => {
    const root = await createRoot();
    const odd = join(root, "odd");

    await mkdir(odd);

    await writeFile(join(odd, ".git"), "not a pointer\n");

    await expect(discover(root)).rejects.toThrow(
      `workspace: ${odd} cannot be protected: git: ${join(odd, ".git")} is not a gitdir file`,
    );
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

describe("bare repositories around a workspace", () => {
  const withBare = async () => {
    const root = await createRoot();
    const bare = join(root, "remote.git");

    await mkdir(root, { recursive: true });
    await git(root, ["init", "--quiet", "--bare", bare]);
    await createRepo(join(root, "checkout"));

    return { root, bare };
  };

  it("accepts a bare repository inside a nested repository, as launching that repository alone does", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "repoA"));
    const fixture = join(repo, "test", "fixtures", "remote.git");

    await mkdir(join(repo, "test", "fixtures"), { recursive: true });
    await git(root, ["init", "--quiet", "--bare", fixture]);

    expect((await scanWorkspace(root, "workspace")).bare).toEqual([fixture]);
    expect((await discover(root)).nested?.map((nested) => nested.repoRoot)).toEqual([repo]);
    expect((await discoverAt(repo, runner, noHooksOf(root))).repoRoot).toBe(repo);
  });

  it("binds a bare repository in the folder read-only as a whole, without asking git or searching inside it", async () => {
    const { root, bare } = await withBare();
    const { runner: fake, calls } = createFakeRunner((call) =>
      call.options.cwd === join(root, "checkout") ? undefined : { code: 0, stdout: "" },
    );

    await markRepo(join(bare, "objects", "planted"));

    const scan = await scanWorkspace(root, "workspace");
    const workspace = await discover(root);

    expect(scan.bare).toEqual([bare]);
    expect(scan.repos).toEqual([join(root, "checkout")]);
    expect(workspace.nested?.map((nested) => nested.repoRoot)).toEqual([join(root, "checkout")]);
    expect(workspace.bareDirs).toEqual([bare]);
    expect(mountedGitDirs(workspace)).toEqual([root, join(root, "checkout", ".git")]);
    expect(workspaceNotices(workspace)).toContain(
      `pi-sandbox: ${bare}: bare repositories, read-only in the sandbox; clone and fetch from them work, push does not`,
    );

    await discoverAt(root, fake, noHooksOf(root)).catch(() => undefined);

    expect(
      calls.some(
        (call) =>
          String(call.options.cwd ?? "").startsWith(bare) || call.args.some((arg) => arg.includes(bare)),
      ),
    ).toBe(false);
  });

  it("refuses to start in a bare repository, and inside one", async () => {
    const { bare } = await withBare();

    await expect(discover(bare)).rejects.toMatchObject({
      message: `workspace: ${bare} is a git dir (a bare repository), refusing`,
      hint: "start pi in a checkout of it or in the folder above",
    });
  });

  it("keeps the git dir of a bare-plus-worktrees layout with its repository", async () => {
    const root = await createRoot();
    const source = await createRepo(join(await createRoot(), "source"));
    const store = join(root, "project", ".bare");
    const main = join(root, "project", "main");

    await mkdir(join(root, "project"));
    await git(root, ["clone", "--quiet", "--bare", source, store]);
    await git(root, [`--git-dir=${store}`, "worktree", "add", "--quiet", main]);

    const workspace = await discover(root);

    expect(workspace.bareDirs).toBeUndefined();
    expect(workspace.nested).toEqual([expect.objectContaining({ repoRoot: main, gitCommonDir: store })]);
  });

  it("treats any folder with HEAD and a commondir, or HEAD, objects and refs of any kind and letter case, as a git dir", async () => {
    const root = await createRoot();
    const shapes: Record<string, string[]> = {
      pointer: ["HEAD", "commondir"],
      files: ["HEAD", "objects", "refs"],
      mixed: ["Head", "OBJECTS", "Refs"],
      plain: ["HEAD", "objects"],
    };

    await Promise.all(
      Object.entries(shapes).map(async ([name, files]) => {
        await mkdir(join(root, name));

        await Promise.all(files.map((file) => writeFile(join(root, name, file), "")));
      }),
    );

    expect((await scanWorkspace(root, "workspace")).bare).toEqual(
      ["files", "mixed", "pointer"].map((name) => join(root, name)),
    );
    expect((await discover(root)).bareDirs).toEqual(
      ["files", "mixed", "pointer"].map((name) => join(root, name)),
    );
    await expect(discover(join(root, "mixed"))).rejects.toThrow(
      `workspace: ${join(root, "mixed")} is a git dir (a bare repository), refusing`,
    );
  });

  it("refuses a folder inside a bare repository and lists it leniently", async () => {
    const { root, bare } = await withBare();
    const hooks = join(bare, "hooks");

    await expect(discover(hooks)).rejects.toMatchObject({
      message: `workspace: ${hooks} lies inside the git dir ${bare}, refusing`,
    });
    expect(await discoverAt(root, runner, noHooksOf(root), { lenient: true })).toMatchObject({
      nested: [expect.objectContaining({ repoRoot: join(root, "checkout") })],
    });
  });
});

describe("the git configuration around a workspace", () => {
  const configured = async (hooksPath: string) => {
    const root = await createRoot();
    const home = await realpath(await tempDir("workspace-home"));
    const env = { ...gitEnv, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };

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
    const workspace = await discoverAt(setup.root, setup.runner, noHooksOf(setup.root));

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
    const workspace = await discoverAt(setup.root, setup.runner, noHooksOf(setup.root));
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
    const env = { ...gitEnv, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };

    await mkdir(home);

    await writeFile(join(home, ".gitconfig"), "[user]\n\tname = test\n");

    await expect(discoverAt(root, createProcessRunner({ baseEnv: env }), noHooksOf(root))).rejects.toThrow(
      `workspace: git configuration ${join(home, ".gitconfig")} lies inside the workspace, refusing`,
    );
  });
  const plainContext = (root: string, workspace?: Workspace) => ({
    runner,
    home: gitHome,
    env: gitEnv,
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
    const env = { ...gitEnv, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
    const notes = join(root, "notes", "a.gitconfig");

    await createRepo(join(root, "a"));

    await mkdir(join(root, "notes"));

    await writeFile(notes, "[user]\n\tname = test\n");

    await writeFile(
      join(home, ".gitconfig"),
      `[includeIf "gitdir:${join(root, "a")}/"]\n\tpath = ${notes}\n`,
    );

    await expect(discoverAt(root, createProcessRunner({ baseEnv: env }), noHooksOf(root))).rejects.toThrow(
      `workspace: git configuration ${notes} lies inside the workspace, refusing`,
    );
  });

  it("refuses an include in the workspace that does not exist yet, at discovery", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "a"));
    const missing = join(root, "shared.gitconfig");

    await git(repo, ["config", "include.path", "../../shared.gitconfig"]);

    await expect(discover(root)).rejects.toThrow(
      `git: ${join(repo, ".git", "config")} includes ${missing}, which does not exist; the sandbox could create it with settings host git would then run`,
    );

    await writeFile(missing, "");

    await expect(discover(root)).rejects.toThrow(
      `workspace: git configuration ${missing} lies inside the workspace, refusing`,
    );
  });

  it("lists each nested repository's configuration once and reuses it for the protected paths", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "a"));
    const calls: string[][] = [];
    const recorder = {
      ...runner,
      run: (file: string, args: string[], options?: Parameters<typeof runner.run>[2]) => {
        calls.push(args.filter((arg) => arg === "rev-parse" || arg === "config"));

        return runner.run(file, args, options);
      },
    };
    const workspace = await discoverAt(root, recorder, noHooksOf(root));
    const nested = workspace.nested?.[0] ?? repoAt(repo);

    await findProtectedGitPaths(nested, join(repo, ".git"), {
      ...plainContext(root, workspace),
      runner: recorder,
    });

    expect(calls.flat().sort()).toEqual(["config", "config", "rev-parse"]);
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

  it("reports a git dir, a bare repository or a letter-case .git created during the session, in a workspace and a repository", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "repo"));
    const shared = join(root, "shared");
    const context = { runner, stateDir: join(root, "state") };
    const review = "review it before running host git tools in this repository";

    await mkdir(shared);
    await git(shared, ["init", "--quiet", "--bare", "old.git"]);

    const workspace = await discover(root);
    const single = await discover(repo);
    const singleContext = { runner, stateDir: join(root, "state-single") };

    await recordGitBaseline(workspace, context);
    await recordGitBaseline(single, singleContext);

    await Promise.all([
      git(root, ["init", "--quiet", "--bare", join(shared, "new.git")]),
      git(root, ["init", "--quiet", "--bare", join(repo, "fixtures", "remote.git")]),
      mkdir(join(root, "planted", ".GIT"), { recursive: true }),
      mkdir(join(shared, "old.git", "nested.git"), { recursive: true }),
    ]);

    const notices = await gitLaunchEndNotices(workspace, context);

    expect(notices).toEqual(
      expect.arrayContaining([
        `git: the sandbox created ${join(root, "planted", ".GIT")}; ${review}`,
        `git: the sandbox created ${join(shared, "new.git")}; ${review}`,
        `git: the sandbox created ${join(repo, "fixtures", "remote.git")}; ${review}`,
      ]),
    );
    expect(notices.some((notice) => notice.includes("old.git"))).toBe(false);
    expect(await gitLaunchEndNotices(single, singleContext)).toEqual([
      `git: the sandbox created ${join(repo, "fixtures", "remote.git")}; ${review}`,
    ]);
  });

  it("reports a .git created in the workspace and inside a nested repository during the session", async () => {
    const root = await createRoot();
    const repo = await createRepo(join(root, "repo"));
    const workspace = await discover(root);
    const context = { runner, stateDir: join(root, "state") };
    await recordGitBaseline(workspace, context);

    await Promise.all([markRepo(join(root, "planted")), markRepo(join(repo, "sub"))]);

    const notices = await gitLaunchEndNotices(workspace, context);

    expect(notices).toEqual([
      `git: the sandbox created ${join(root, "planted", ".git")}; review it before running host git tools in this repository`,
      `git: the sandbox created ${join(repo, "sub", ".git")}; review it before running host git tools in this repository`,
    ]);
  });
});
