import { realpathSync } from "node:fs";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertWithinHostRoot,
  assertWithinWorkspaceRoot,
  checkRoot,
  requiredRoot,
  rootRefusal,
  sharedRootOf,
  type Workspace,
} from "../../workspace/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const createTree = async () => {
  const unresolved = await tempDir("roots");
  const base = await realpath(unresolved);

  await mkdir(join(base, "work", "repo"), { recursive: true });
  await mkdir(join(base, "elsewhere"), { recursive: true });

  return { unresolved, base };
};

const workspaceAt = (repoRoot: string, gitCommonDir?: string): Workspace => ({
  cwd: repoRoot,
  repoRoot,
  gitCommonDir,
  isGitRepo: gitCommonDir !== undefined,
});

const NO_HOME = { home: "/nonexistent-home", env: {} };

describe("requiredRoot", () => {
  it("refuses an unset root, naming the user config file", () => {
    expect(() =>
      requiredRoot(undefined, { home: "/h", env: { PI_SANDBOX_USER_CONFIG: "/c/config.json" } }),
    ).toThrow("config: workspaceRoot is not set, so pi has no folder it may start in");
    expect(requiredRoot("~/work", NO_HOME)).toBe("~/work");
  });
});

describe("assertWithinWorkspaceRoot", () => {
  it("refuses everything when no root is configured", () => {
    expect(() => assertWithinWorkspaceRoot(workspaceAt("/"), undefined, NO_HOME)).toThrow(
      "config: workspaceRoot is not set",
    );
  });

  it("accepts a repository inside the root, comparing real paths", async () => {
    const { unresolved, base } = await createTree();
    const repo = join(base, "work", "repo");

    expect(() =>
      assertWithinWorkspaceRoot(workspaceAt(repo, join(repo, ".git")), join(unresolved, "work"), NO_HOME),
    ).not.toThrow();
  });

  it("refuses a repository outside the root", async () => {
    const { base } = await createTree();
    const outside = join(base, "elsewhere");

    expect(() => assertWithinWorkspaceRoot(workspaceAt(outside), join(base, "work"), NO_HOME)).toThrow(
      `${outside} is outside the workspace root (workspaceRoot: ${join(base, "work")})`,
    );
  });

  it("refuses a linked worktree whose common dir is outside the root", async () => {
    const { base } = await createTree();

    expect(() =>
      assertWithinWorkspaceRoot(
        workspaceAt(join(base, "work", "repo"), join(base, "elsewhere", ".git")),
        join(base, "work"),
        NO_HOME,
      ),
    ).toThrow("elsewhere");
  });

  it("refuses a repository whose git common dir is outside the root, saying git would not work", async () => {
    const { base } = await createTree();
    const repo = join(base, "work", "repo");
    const common = join(base, "elsewhere", ".git");
    const workspace: Workspace = { ...workspaceAt(repo, common), gitDir: join(common, "worktrees", "repo") };

    expect(() => assertWithinWorkspaceRoot(workspace, join(base, "work"), NO_HOME)).toThrow(
      `git: the git dir ${join(common, "worktrees", "repo")} of ${repo} is outside the workspace root (workspaceRoot: ${join(base, "work")})`,
    );
  });

  it("accepts a repository whose git dirs lie elsewhere inside the root", async () => {
    const { base } = await createTree();
    const repo = join(base, "work", "repo");
    const common = join(base, "work", "main", ".git");

    expect(() =>
      assertWithinWorkspaceRoot(workspaceAt(repo, common), join(base, "work"), NO_HOME),
    ).not.toThrow();
  });

  it("expands a ~ root against the given home, as the VM shares do", async () => {
    const { base } = await createTree();
    const repo = join(base, "work", "repo");

    expect(() =>
      assertWithinWorkspaceRoot(workspaceAt(repo), "~/work", { home: base, env: {} }),
    ).not.toThrow();
  });

  it("does not treat a sibling with the same prefix as inside", async () => {
    const { base } = await createTree();
    const sibling = join(base, "work-other");

    await mkdir(sibling);

    expect(() => assertWithinWorkspaceRoot(workspaceAt(sibling), join(base, "work"), NO_HOME)).toThrow(
      `${sibling} is outside the workspace root`,
    );
  });

  it("refuses the home dir or a folder that holds it before it looks at the workspace", async () => {
    const { base } = await createTree();
    const home = { home: join(base, "work"), env: {} };
    const repo = workspaceAt(join(base, "work", "repo"));

    expect(() => assertWithinWorkspaceRoot(repo, join(base, "work"), home)).toThrow(
      `config: workspaceRoot: ${join(base, "work")} is the home dir or holds it`,
    );
    expect(() => assertWithinWorkspaceRoot(repo, base, home)).toThrow(
      `config: workspaceRoot: ${base} is the home dir or holds it`,
    );
    expect(() => assertWithinWorkspaceRoot(repo, "~", home)).toThrow(
      "config: workspaceRoot: ~ is the home dir or holds it",
    );
  });
});

describe("assertWithinHostRoot", () => {
  it("accepts any folder when no root is configured", () => {
    expect(() => assertWithinHostRoot(workspaceAt("/"), undefined, NO_HOME)).not.toThrow();
  });

  it("accepts a root that holds the home dir, as no VM shares it", async () => {
    const { base } = await createTree();
    const repo = join(base, "work", "repo");

    expect(() =>
      assertWithinHostRoot(workspaceAt(repo), base, { home: join(base, "work"), env: {} }),
    ).not.toThrow();
  });

  it("still refuses a repository outside the root or a root that does not exist", async () => {
    const { base } = await createTree();

    expect(() =>
      assertWithinHostRoot(workspaceAt(join(base, "elsewhere")), join(base, "work"), NO_HOME),
    ).toThrow("is outside the workspace root");
    expect(() => assertWithinHostRoot(workspaceAt(join(base, "work")), join(base, "gone"), NO_HOME)).toThrow(
      `config: workspaceRoot: ${join(base, "gone")} does not exist`,
    );
  });

  it("accepts a worktree under the root whose main repository is outside it, which a sandbox launch refuses", async () => {
    const { base } = await createTree();
    const repo = join(base, "work", "repo");
    const common = join(base, "elsewhere", ".git");
    const worktree: Workspace = { ...workspaceAt(repo, common), gitDir: join(common, "worktrees", "repo") };

    expect(() => assertWithinHostRoot(worktree, join(base, "work"), NO_HOME)).not.toThrow();
    expect(() => assertWithinWorkspaceRoot(worktree, join(base, "work"), NO_HOME)).toThrow(
      `git: the git dir ${join(common, "worktrees", "repo")} of ${repo} is outside the workspace root`,
    );
  });
});

const createHome = async () => {
  const base = await realpath(await tempDir("shared-roots"));
  const home = join(base, "home");
  const env = {
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SANDBOX_STATE_DIR: join(base, "state"),
    PI_SANDBOX_USER_CONFIG: join(base, "config", "config.json"),
  };

  await Promise.all(
    [
      join(base, "work", "a", "b"),
      join(base, "other"),
      join(home, "code"),
      join(home, "Projects"),
      env.PI_CODING_AGENT_DIR,
      env.PI_SANDBOX_STATE_DIR,
    ].map((dir) => mkdir(dir, { recursive: true })),
  );

  return { base, paths: { home, env } };
};

describe("sharedRootOf", () => {
  it("resolves ~ and the links of the root", async () => {
    const { base, paths } = await createHome();
    const link = join(base, "link");

    await symlink(join(base, "work"), link);

    expect(sharedRootOf("~/code", paths)).toEqual({ root: join(paths.home, "code"), notices: [] });
    expect(sharedRootOf(link, paths)).toEqual({ root: join(base, "work"), notices: [] });
  });

  it("skips a root that does not exist with a notice", async () => {
    const { base, paths } = await createHome();
    const missing = join(base, "missing");

    expect(sharedRootOf(missing, paths)).toEqual({
      notices: [`workspaceRoot: ${missing} is missing, so it is not shared until it exists`],
    });
  });

  it("escapes control and bidi characters of a stored root it echoes", async () => {
    const { base, paths } = await createHome();
    const planted = join(base, "gone\u202e\u200f");

    expect(sharedRootOf(planted, paths).notices).toEqual([
      `workspaceRoot: ${join(base, "gone\\u202E\\u200F")} is missing, so it is not shared until it exists`,
    ]);
    expect(() => assertWithinWorkspaceRoot(workspaceAt(join(base, "other")), planted, NO_HOME)).toThrow(
      `config: workspaceRoot: ${join(base, "gone\\u202E\\u200F")} does not exist`,
    );
    expect(() => sharedRootOf("~/a:b\u202e", paths)).toThrow('config: workspaceRoot: ~/a:b\\u202E holds ","');
  });

  it("accepts a root next to the protected home paths", async () => {
    const { paths } = await createHome();

    expect(sharedRootOf("~/Projects", paths).root).toEqual(join(paths.home, "Projects"));
  });

  it("refuses a root that a link turns into a protected folder", async () => {
    const { base, paths } = await createHome();
    const data = join(base, "work", "a", "data");

    await mkdir(join(paths.home, ".ssh"));

    await symlink(join(paths.home, ".ssh"), data);

    expect(() => sharedRootOf(data, paths)).toThrow(`config: workspaceRoot: ${data} overlaps ~/.ssh`);
  });

  it.each([
    ["a comma", (base: string) => join(base, "a,b"), 'holds "," or ":"'],
    ["a colon", (base: string) => join(base, "a:b"), 'holds "," or ":"'],
    ["the home dir", (base: string) => join(base, "home"), "is the home dir or holds it"],
    ["an ancestor of the home dir", (base: string) => base, "is the home dir or holds it"],
    ["the agent dir", (base: string) => join(base, "home", ".pi", "agent"), "overlaps pi's directory"],
    [
      "a folder holding the agent dir",
      (base: string) => join(base, "home", ".pi"),
      "overlaps pi's directory",
    ],
    [
      "a folder in the agent dir",
      (base: string) => join(base, "home", ".pi", "agent", "x"),
      "overlaps pi's directory",
    ],
    ["the state dir", (base: string) => join(base, "state"), "overlaps pinata's state directory"],
    ["a folder in the state dir", (base: string) => join(base, "state", "x"), "overlaps pinata's state"],
    ["the user config dir", (base: string) => join(base, "config"), "overlaps pinata's user config"],
    [
      "a folder in the user config dir",
      (base: string) => join(base, "config", "x"),
      "overlaps pinata's config dir",
    ],
    ["~/.ssh", (base: string) => join(base, "home", ".ssh"), "overlaps ~/.ssh"],
    ["a folder in ~/.colima", (base: string) => join(base, "home", ".colima", "x"), "overlaps ~/.colima"],
    ["~/.config", (base: string) => join(base, "home", ".config"), "overlaps ~/.config"],
    ["a folder in ~/.config", (base: string) => join(base, "home", ".config", "gh"), "overlaps ~/.config"],
    ["~/.gnupg", (base: string) => join(base, "home", ".gnupg"), "overlaps ~/.gnupg"],
    ["~/.aws", (base: string) => join(base, "home", ".aws"), "overlaps ~/.aws"],
    ["~/.docker", (base: string) => join(base, "home", ".docker"), "overlaps ~/.docker"],
    ["~/.kube", (base: string) => join(base, "home", ".kube"), "overlaps ~/.kube"],
    ["~/.local/bin", (base: string) => join(base, "home", ".local", "bin"), "overlaps ~/.local/bin"],
    ["~/.local", (base: string) => join(base, "home", ".local"), "overlaps ~/.local/bin"],
    [
      "a folder in ~/Library",
      (base: string) => join(base, "home", "Library", "LaunchAgents"),
      "overlaps ~/Library",
    ],
    ["a newline", (base: string) => join(base, "a\nb"), "holds a newline or another control character"],
  ])("refuses %s", async (_name, rootOf, problem) => {
    const { base, paths } = await createHome();
    const root = rootOf(base);
    const shown = root.includes("\n") ? JSON.stringify(root) : root;

    expect(() => sharedRootOf(root, paths)).toThrow(`config: workspaceRoot: ${shown} ${problem}`);
  });

  it.each([
    ["/etc", "/etc", "overlaps /etc"],
    ["a folder in /usr", "/usr/local/bin", "overlaps /usr"],
    ["a folder in /opt", "/opt/homebrew", "overlaps /opt"],
    ["/System", "/System", "overlaps /System"],
    ["a folder in /Library", "/Library/LaunchDaemons", "overlaps /Library"],
    ["/bin", "/bin", `overlaps ${realpathSync("/bin")}`],
    ["a folder in /sbin", "/sbin/x", "overlaps /sbin"],
    ["/private", "/private", ""],
    ["/var", "/var", ""],
    ["/", "/", "is the home dir or holds it"],
  ])("refuses the system dir %s", async (_name, root, problem) => {
    const { paths } = await createHome();

    expect(() => sharedRootOf(root, paths)).toThrow(`config: workspaceRoot: ${root} ${problem}`);
  });
});

describe("checkRoot", () => {
  const contextOf = async () => {
    const home = await realpath(await tempDir("check-root-home"));

    await mkdir(join(home, "work"), { recursive: true });

    await mkdir(join(home, ".ssh", "keys"), { recursive: true });

    return { home, env: { PI_CODING_AGENT_DIR: join(home, "tools", "agent") } };
  };

  it("accepts a folder under the home, resolved, and says whether it exists", async () => {
    const context = await contextOf();

    expect(checkRoot("~/work", context)).toEqual({
      ok: true,
      resolved: join(context.home, "work"),
      exists: true,
    });
    expect(checkRoot("~/later", context)).toEqual({
      ok: true,
      resolved: join(context.home, "later"),
      exists: false,
    });
  });

  it("accepts a folder on another volume, which need not exist yet", async () => {
    const context = await contextOf();

    expect(checkRoot("/Volumes/Projects", context)).toMatchObject({
      ok: true,
      resolved: "/Volumes/Projects",
    });
    expect(checkRoot("/Volumes/pi-sandbox-test-absent", context)).toEqual({
      ok: true,
      resolved: "/Volumes/pi-sandbox-test-absent",
      exists: false,
    });
  });

  it("names each kind of refusal", async () => {
    const context = await contextOf();

    expect(checkRoot("~/a\u0007b", context)).toEqual({ ok: false, problem: { kind: "control" } });
    expect(checkRoot("~/a,b", context)).toEqual({ ok: false, problem: { kind: "mount-syntax" } });
    expect(checkRoot("~", context)).toEqual({ ok: false, problem: { kind: "home" } });
    expect(checkRoot("/", context)).toEqual({ ok: false, problem: { kind: "home" } });
    expect(checkRoot("~/.ssh/keys", context)).toMatchObject({ ok: false, problem: { kind: "inside" } });
    expect(checkRoot("/etc/x", context)).toEqual({
      ok: false,
      problem: { kind: "inside", name: "/etc", path: "/etc" },
    });
    expect(checkRoot("~/tools", context)).toMatchObject({ ok: false, problem: { kind: "holds" } });
  });

  it("gives the launch's own refusal text for a problem", async () => {
    const context = await contextOf();
    const verdict = checkRoot("~/.ssh/keys", context);

    expect(verdict.ok).toBe(false);
    expect(() => sharedRootOf("~/.ssh/keys", context)).toThrow(
      verdict.ok ? "" : rootRefusal("~/.ssh/keys", verdict.problem),
    );
  });
});
