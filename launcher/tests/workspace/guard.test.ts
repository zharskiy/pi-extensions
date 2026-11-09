import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeWorkspace, type Workspace } from "../../workspace/index.ts";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const createHome = async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-guard-")));
  const home = join(base, "home");

  created.push(base);

  await mkdir(join(home, "work", "repo"), { recursive: true });

  return { base, home, context: { home, env: {}, platform: "linux" as const } };
};

const workspaceAt = (repoRoot: string, gitCommonDir?: string): Workspace => ({
  cwd: repoRoot,
  repoRoot,
  gitCommonDir,
  isGitRepo: gitCommonDir !== undefined,
});

describe("assertSafeWorkspace", () => {
  it("accepts a project directory under the home", async () => {
    const { home, context } = await createHome();
    const repo = join(home, "work", "repo");

    expect(() => assertSafeWorkspace(workspaceAt(repo, join(repo, ".git")), context)).not.toThrow();
  });

  it("refuses a repository rooted at the home, as a dotfiles repository is", async () => {
    const { home, context } = await createHome();

    expect(() => assertSafeWorkspace(workspaceAt(home, join(home, ".git")), context)).toThrow(
      `${home} would mount ${home} into the sandbox, refusing`,
    );
  });

  it("refuses a repository that contains the home, ~/.pi, the state dir or the user config dir", async () => {
    const { base, home, context } = await createHome();
    const attempts = [
      { workspace: workspaceAt(base), context },
      { workspace: workspaceAt(join(home, ".pi")), context },
      { workspace: workspaceAt(join(home, ".local")), context },
      { workspace: workspaceAt(join(home, ".config", "pi-sandbox")), context },
      {
        workspace: workspaceAt("/srv/state"),
        context: { ...context, env: { PI_SANDBOX_STATE_DIR: "/srv/state/x" } },
      },
    ];

    attempts.forEach(({ workspace, context: guard }) => {
      expect(() => assertSafeWorkspace(workspace, guard)).toThrow("refusing");
    });
  });

  it("refuses a repository or git common dir inside ~/.pi, the state dir or the user config dir", async () => {
    const { base, home, context } = await createHome();
    const attempts = [
      { workspace: workspaceAt(join(home, ".pi", "agent", "repo")), context },
      { workspace: workspaceAt(join(home, ".local", "state", "pi-sandbox", "copies")), context },
      { workspace: workspaceAt(join(home, ".config", "pi-sandbox", "repo")), context },
      { workspace: workspaceAt(join(base, "worktree"), join(home, ".pi", "repo.git")), context },
      {
        workspace: workspaceAt("/srv/state/repo"),
        context: { ...context, env: { PI_SANDBOX_STATE_DIR: "/srv/state" } },
      },
    ];

    attempts.forEach(({ workspace, context: guard }) => {
      expect(() => assertSafeWorkspace(workspace, guard)).toThrow(/is inside .*, refusing/);
    });
  });

  it("refuses a repository inside ~/.ssh", async () => {
    const { home, context } = await createHome();
    const repo = join(home, ".ssh", "keys");

    expect(() => assertSafeWorkspace(workspaceAt(repo, join(repo, ".git")), context)).toThrow(
      `${repo} is inside ${join(home, ".ssh")}, refusing to mount it into the sandbox`,
    );
  });

  it("refuses a repository or git common dir inside another protected home or system directory", async () => {
    const { base, home, context } = await createHome();
    const attempts = [
      workspaceAt(join(home, ".aws", "config-repo")),
      workspaceAt(join(base, "worktree"), join(home, ".gnupg", "repo.git")),
      workspaceAt("/etc/pi-sandbox-repo"),
    ];

    attempts.forEach((workspace) => {
      expect(() => assertSafeWorkspace(workspace, context)).toThrow(/is inside .*, refusing/);
    });
  });

  it("refuses a repository that contains or lies inside a custom PI_CODING_AGENT_DIR", async () => {
    const { base, context } = await createHome();
    const agentDir = join(base, "agents", "pi");
    const custom = { ...context, env: { PI_CODING_AGENT_DIR: agentDir } };

    expect(() => assertSafeWorkspace(workspaceAt(join(base, "agents")), custom)).toThrow(
      `${join(base, "agents")} would mount ${agentDir} into the sandbox, refusing`,
    );
    expect(() => assertSafeWorkspace(workspaceAt(join(agentDir, "install", "releases")), custom)).toThrow(
      `${join(agentDir, "install", "releases")} is inside ${agentDir}, refusing`,
    );
    expect(() => assertSafeWorkspace(workspaceAt(join(base, "agents")), context)).not.toThrow();
  });

  it("protects only the user config file, not its directory, when PI_SANDBOX_USER_CONFIG points elsewhere", async () => {
    const { base, context } = await createHome();
    const configDir = join(base, "shared-config");
    const custom = { ...context, env: { PI_SANDBOX_USER_CONFIG: join(configDir, "pi.json") } };

    expect(() => assertSafeWorkspace(workspaceAt(configDir), custom)).toThrow("would mount");
    expect(() => assertSafeWorkspace(workspaceAt(base), custom)).toThrow("would mount");
    expect(() => assertSafeWorkspace(workspaceAt(join(configDir, "project")), custom)).not.toThrow();
    expect(() => assertSafeWorkspace(workspaceAt(join(configDir, "project")), context)).not.toThrow();
  });

  it("refuses a git common dir that is the home even when the worktree is elsewhere", async () => {
    const { base, home, context } = await createHome();

    expect(() => assertSafeWorkspace(workspaceAt(join(base, "worktree"), home), context)).toThrow(
      "would mount",
    );
  });

  it("refuses the filesystem root and hints at a project directory", async () => {
    const { context } = await createHome();

    try {
      assertSafeWorkspace(workspaceAt("/"), context);
    } catch (error) {
      expect(error).toMatchObject({ message: "/ would mount / into the sandbox, refusing" });
      expect(error).toMatchObject({ hint: "run pi inside a project directory" });

      return;
    }

    throw new Error("expected a refusal");
  });
});
