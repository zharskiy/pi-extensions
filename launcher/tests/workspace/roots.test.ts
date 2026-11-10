import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertWithinWorkspaceRoots, type Workspace } from "../../workspace/index.ts";
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

  it("does not treat a sibling with the same prefix as inside", async () => {
    const { base } = await createTree();
    const sibling = join(base, "work-other");

    await mkdir(sibling);

    expect(() => assertWithinWorkspaceRoots(workspaceAt(sibling), { roots: [join(base, "work")] })).toThrow(
      `${sibling} is outside the allowed workspace roots`,
    );
  });
});
