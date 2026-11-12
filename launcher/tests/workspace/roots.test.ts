import { mkdir, realpath } from "node:fs/promises";
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
  const paths = { home, agentDir: join(home, ".pi", "agent"), stateDir: join(base, "state") };

  await Promise.all(
    [
      join(base, "work", "a", "b"),
      join(base, "other"),
      join(home, "code"),
      paths.agentDir,
      paths.stateDir,
    ].map((dir) => mkdir(dir, { recursive: true })),
  );

  return { base, paths };
};

describe("sharedRootsOf", () => {
  it("keeps the outer of two nested roots and resolves ~", async () => {
    const { base, paths } = await createHome();

    expect(
      sharedRootsOf(
        { roots: [join(base, "work", "a"), join(base, "work"), "~/code", join(base, "work")] },
        paths,
      ),
    ).toEqual({ roots: [join(base, "work"), join(paths.home, "code")], notices: [] });
  });

  it("skips a root that does not exist with a notice", async () => {
    const { base, paths } = await createHome();
    const missing = join(base, "missing");

    expect(sharedRootsOf({ roots: [missing, join(base, "other")] }, paths)).toEqual({
      roots: [join(base, "other")],
      notices: [`workspaceRoots: ${missing} does not exist, not shared`],
    });
  });

  it.each([
    ["a comma", (base: string) => join(base, "a,b"), 'holds "," or ":"'],
    ["a colon", (base: string) => join(base, "a:b"), 'holds "," or ":"'],
    ["the home dir", (base: string) => join(base, "home"), "is the home dir or holds it"],
    ["an ancestor of the home dir", (base: string) => base, "is the home dir or holds it"],
    ["the agent dir", (base: string) => join(base, "home", ".pi", "agent"), "overlaps the pi agent dir"],
    [
      "a folder holding the agent dir",
      (base: string) => join(base, "home", ".pi"),
      "overlaps the pi agent dir",
    ],
    [
      "a folder in the agent dir",
      (base: string) => join(base, "home", ".pi", "agent", "x"),
      "overlaps the pi agent dir",
    ],
    ["the state dir", (base: string) => join(base, "state"), "overlaps the launcher state dir"],
    ["~/.ssh", (base: string) => join(base, "home", ".ssh"), "overlaps ~/.ssh"],
  ])("refuses %s", async (_name, rootOf, problem) => {
    const { base, paths } = await createHome();
    const root = rootOf(base);

    expect(() => sharedRootsOf({ roots: [join(base, "other"), root] }, paths)).toThrow(
      `config: workspaceRoots.roots: ${root} ${problem}`,
    );
  });
});
