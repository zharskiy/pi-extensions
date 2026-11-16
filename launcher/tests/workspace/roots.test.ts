import { realpathSync } from "node:fs";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertWithinWorkspaceRoots, sharedRootsOf, type Workspace } from "../../workspace/index.ts";
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

describe("assertWithinWorkspaceRoots", () => {
  it("allows everything when no roots are configured", () => {
    expect(() => assertWithinWorkspaceRoots(workspaceAt("/"), undefined)).not.toThrow();
  });

  it("accepts a repository inside a root, comparing real paths", async () => {
    const { unresolved, base } = await createTree();
    const repo = join(base, "work", "repo");

    expect(() =>
      assertWithinWorkspaceRoots(workspaceAt(repo, join(repo, ".git")), {
        roots: [join(unresolved, "work")],
      }),
    ).not.toThrow();
  });

  it("refuses a repository outside the roots", async () => {
    const { base } = await createTree();
    const outside = join(base, "elsewhere");

    expect(() => assertWithinWorkspaceRoots(workspaceAt(outside), { roots: [join(base, "work")] })).toThrow(
      `${outside} is outside the allowed workspace roots`,
    );
  });

  it("refuses a linked worktree whose common dir is outside the roots", async () => {
    const { base } = await createTree();

    expect(() =>
      assertWithinWorkspaceRoots(workspaceAt(join(base, "work", "repo"), join(base, "elsewhere", ".git")), {
        roots: [join(base, "work")],
      }),
    ).toThrow("elsewhere");
  });

  it("refuses a workspace whose nested repository keeps its git dir outside the roots, naming the key", async () => {
    const { base } = await createTree();
    const nested = { ...workspaceAt(join(base, "work", "repo"), join(base, "elsewhere", ".git")), cwd: base };
    const workspace: Workspace = {
      cwd: base,
      repoRoot: join(base, "work"),
      isGitRepo: false,
      nested: [nested],
    };

    expect(() => assertWithinWorkspaceRoots(workspace, { roots: [join(base, "work")] })).toThrow(
      `${join(base, "elsewhere", ".git")} is outside the allowed workspace roots (workspaceRoots.roots: ${join(base, "work")})`,
    );
  });

  it("does not treat a sibling with the same prefix as inside", async () => {
    const { base } = await createTree();
    const sibling = join(base, "work-other");

    await mkdir(sibling);

    expect(() => assertWithinWorkspaceRoots(workspaceAt(sibling), { roots: [join(base, "work")] })).toThrow(
      `${sibling} is outside the allowed workspace roots`,
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

describe("sharedRootsOf", () => {
  it("keeps the outer of two nested roots and resolves ~", async () => {
    const { base, paths } = await createHome();

    expect(
      sharedRootsOf(
        { roots: [join(base, "work", "a"), join(base, "work"), "~/code", join(base, "work")] },
        paths,
      ),
    ).toEqual({ roots: [join(base, "work"), join(paths.home, "code")], missing: [], notices: [] });
  });

  it("skips a root that does not exist with a notice", async () => {
    const { base, paths } = await createHome();
    const missing = join(base, "missing");

    expect(sharedRootsOf({ roots: [missing, join(base, "other")] }, paths)).toEqual({
      roots: [join(base, "other")],
      missing: [missing],
      notices: [`workspaceRoots: ${missing} does not exist, not shared`],
    });
  });

  it("accepts a root next to the protected home paths", async () => {
    const { paths } = await createHome();

    expect(sharedRootsOf({ roots: ["~/Projects"] }, paths).roots).toEqual([join(paths.home, "Projects")]);
  });

  it("drops a root lexically inside another before following its links", async () => {
    const { base, paths } = await createHome();
    const data = join(base, "work", "a", "data");

    await symlink(join(paths.home, ".ssh"), data);

    expect(sharedRootsOf({ roots: [join(base, "work"), data] }, paths)).toEqual({
      roots: [join(base, "work")],
      missing: [],
      notices: [],
    });
  });

  it("drops a nested root that a link turned into another folder, for the workspace check too", async () => {
    const { base, paths } = await createHome();
    const data = join(base, "work", "a", "data");

    await symlink(join(base, "other"), data);

    expect(sharedRootsOf({ roots: [join(base, "work"), data] }, paths).roots).toEqual([join(base, "work")]);
    expect(() =>
      assertWithinWorkspaceRoots(workspaceAt(join(base, "other")), { roots: [join(base, "work"), data] }),
    ).toThrow(`${join(base, "other")} is outside the allowed workspace roots`);
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
    ["the state dir", (base: string) => join(base, "state"), "overlaps the launcher state directory"],
    ["a folder in the state dir", (base: string) => join(base, "state", "x"), "overlaps the launcher state"],
    ["the user config dir", (base: string) => join(base, "config"), "overlaps the launcher user config"],
    [
      "a folder in the user config dir",
      (base: string) => join(base, "config", "x"),
      "overlaps the launcher config dir",
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

    expect(() => sharedRootsOf({ roots: [join(base, "other"), root] }, paths)).toThrow(
      `config: workspaceRoots.roots: ${shown} ${problem}`,
    );
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

    expect(() => sharedRootsOf({ roots: [root] }, paths)).toThrow(
      `config: workspaceRoots.roots: ${root} ${problem}`,
    );
  });
});
