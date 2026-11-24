import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeMounts } from "../../workspace/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const createHome = async () => {
  const base = await realpath(await tempDir("guard"));
  const home = join(base, "home");

  await mkdir(join(home, "work", "repo"), { recursive: true });

  return { base, home, context: { home, env: {}, platform: "linux" as const } };
};

describe("assertSafeMounts", () => {
  it("accepts a project directory under the home", async () => {
    const { home, context } = await createHome();
    const repo = join(home, "work", "repo");

    expect(() => assertSafeMounts([repo], context)).not.toThrow();
  });

  it("refuses a repository rooted at the home, as a dotfiles repository is", async () => {
    const { home, context } = await createHome();

    expect(() => assertSafeMounts([home], context)).toThrow(
      `pi may not start in ${home}, a protected folder, refusing`,
    );
  });

  it("refuses a repository that contains the home, ~/.pi, the launcher folder, the state dir or the user config", async () => {
    const { base, home, context } = await createHome();
    const attempts = [
      { workspace: base, context },
      { workspace: join(home, ".pi"), context },
      { workspace: join(home, ".pi", "agent", "pinata"), context },
      {
        workspace: "/srv/pi",
        context: { ...context, env: { PI_CODING_AGENT_DIR: "/srv/pi/agent" } },
      },
      {
        workspace: "/srv/config",
        context: { ...context, env: { PINATA_USER_CONFIG: "/srv/config/sandbox.json" } },
      },
      {
        workspace: "/srv/state",
        context: { ...context, env: { PINATA_STATE_DIR: "/srv/state/x" } },
      },
    ];

    attempts.forEach(({ workspace, context: guard }) => {
      expect(() => assertSafeMounts([workspace], guard)).toThrow("refusing");
    });
  });

  it("refuses a repository inside ~/.pi, the launcher folder or the state dir", async () => {
    const { home, context } = await createHome();
    const attempts = [
      { workspace: join(home, ".pi", "agent", "repo"), context },
      { workspace: join(home, ".pi", "agent", "pinata", "state", "copies"), context },
      {
        workspace: "/srv/agent/pinata/repo",
        context: { ...context, env: { PI_CODING_AGENT_DIR: "/srv/agent" } },
      },
      {
        workspace: "/srv/state/repo",
        context: { ...context, env: { PINATA_STATE_DIR: "/srv/state" } },
      },
    ];

    attempts.forEach(({ workspace, context: guard }) => {
      expect(() => assertSafeMounts([workspace], guard)).toThrow(/is inside .*, refusing/);
    });
  });

  it("refuses a repository inside ~/.ssh", async () => {
    const { home, context } = await createHome();
    const repo = join(home, ".ssh", "keys");

    expect(() => assertSafeMounts([repo], context)).toThrow(
      `${repo} is inside ${join(home, ".ssh")}, refusing to mount it into the sandbox`,
    );
  });

  it("refuses a repository inside another protected home or system directory", async () => {
    const { home, context } = await createHome();
    const attempts = [join(home, ".aws", "config-repo"), "/etc/pinata-repo"];

    attempts.forEach((workspace) => {
      expect(() => assertSafeMounts([workspace], context)).toThrow(/is inside .*, refusing/);
    });
  });

  it("refuses a repository that contains or lies inside a custom PI_CODING_AGENT_DIR", async () => {
    const { base, context } = await createHome();
    const agentDir = join(base, "agents", "pi");
    const custom = { ...context, env: { PI_CODING_AGENT_DIR: agentDir } };

    expect(() => assertSafeMounts([join(base, "agents")], custom)).toThrow(
      `pi may not start in ${join(base, "agents")}: it holds ${agentDir}, refusing`,
    );
    expect(() => assertSafeMounts([join(agentDir, "install", "releases")], custom)).toThrow(
      `${join(agentDir, "install", "releases")} is inside ${agentDir}, refusing`,
    );
    expect(() => assertSafeMounts([join(base, "agents")], context)).not.toThrow();
  });

  it("protects only the user config file, not its directory, when PINATA_USER_CONFIG points elsewhere", async () => {
    const { base, context } = await createHome();
    const configDir = join(base, "shared-config");
    const custom = { ...context, env: { PINATA_USER_CONFIG: join(configDir, "pi.json") } };

    expect(() => assertSafeMounts([configDir], custom)).toThrow("pi may not start in");
    expect(() => assertSafeMounts([base], custom)).toThrow("pi may not start in");
    expect(() => assertSafeMounts([join(configDir, "project")], custom)).not.toThrow();
    expect(() => assertSafeMounts([join(configDir, "project")], context)).not.toThrow();
  });

  it("checks a single folder with the same table before anything is searched", async () => {
    const { home, context } = await createHome();

    expect(() => assertSafeMounts([home], context)).toThrow(
      `pi may not start in ${home}, a protected folder, refusing`,
    );
    expect(() => assertSafeMounts([join(home, "work")], context)).not.toThrow();
  });

  it("refuses a folder that is or contains a directory the sandbox image uses, not one below it", async () => {
    const { context } = await createHome();

    expect(() => assertSafeMounts(["/opt"], context)).toThrow(
      "pi may not start in /opt, a protected folder, refusing",
    );
    expect(() => assertSafeMounts(["/usr/local"], context)).toThrow(
      "pi may not start in /usr/local, a protected folder, refusing",
    );
    expect(() => assertSafeMounts(["/opt/src/project"], context)).not.toThrow();
  });

  it("refuses the filesystem root and hints at a project directory", async () => {
    const { home, context } = await createHome();

    try {
      assertSafeMounts(["/"], context);
    } catch (error) {
      expect(error).toMatchObject({ message: `pi may not start in /: it holds ${home}, refusing` });
      expect(error).toMatchObject({ hint: "run pi inside a project directory" });

      return;
    }

    throw new Error("expected a refusal");
  });
});
