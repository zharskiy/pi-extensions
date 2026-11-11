import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { protectedRealPathGuard } from "../../workspace/mounts.ts";
import { tempDir } from "../support/temp-dir.ts";

const setup = async () => {
  const base = await realpath(await tempDir("mounts"));
  const home = join(base, "home");

  await mkdir(join(home, "work", "repo"), { recursive: true });

  const reasonOf = (path: string, env: NodeJS.ProcessEnv = {}) => protectedRealPathGuard({ home, env })(path);

  return { base, home, reasonOf };
};

describe("protectedRealPathGuard", () => {
  it("accepts a folder under the home and a folder below an image dir", async () => {
    const { home, reasonOf } = await setup();

    expect(reasonOf(join(home, "work", "repo"))).toBeUndefined();
    expect(reasonOf("/opt/src/project")).toBeUndefined();
  });

  it("names the home itself and anything that contains it", async () => {
    const { base, home, reasonOf } = await setup();

    expect(reasonOf(home)).toBe("it is the home directory");
    expect(reasonOf(base)).toBe("it contains the home directory");
    expect(reasonOf("/")).toBe("it contains the home directory");
  });

  it("names pi's dir, the configured agent dir, the launcher folder, the state dir and the user config", async () => {
    const { base, home, reasonOf } = await setup();
    const agent = join(base, "agent");
    const state = join(base, "state");
    const config = join(base, "config", "sandbox.json");

    await mkdir(join(home, ".config", "pi-sandbox"), { recursive: true });

    await writeFile(join(home, ".config", "pi-sandbox", "config.json"), "{}");

    expect(reasonOf(join(home, ".pi"))).toBe("it is pi's directory");
    expect(reasonOf(join(home, ".pi", "agent"))).toBe("it is inside pi's directory");
    expect(reasonOf(join(agent, "skills"), { PI_CODING_AGENT_DIR: agent })).toBe(
      "it is inside pi's agent directory",
    );
    expect(reasonOf(join(state, "proxy"), { PI_SANDBOX_STATE_DIR: state })).toBe(
      "it is inside the launcher state directory",
    );
    expect(reasonOf(join(agent, "pi-sandbox", "state"), { PI_CODING_AGENT_DIR: agent })).toBe(
      "it is inside pi's agent directory",
    );
    expect(reasonOf(join(base, "pi"), { PI_CODING_AGENT_DIR: join(base, "pi", "agent") })).toBe(
      "it contains pi's agent directory",
    );
    expect(reasonOf(join(base, "config"), { PI_SANDBOX_USER_CONFIG: config })).toBe(
      "it contains the launcher user config",
    );
    expect(reasonOf(join(home, ".config"))).toBeUndefined();
  });

  it("names credential and engine dirs in the home, and what lies inside them", async () => {
    const { home, reasonOf } = await setup();

    [".ssh", ".gnupg", ".aws", ".docker", ".colima", ".kube"].forEach((name) => {
      expect(reasonOf(join(home, name))).toBe(`it is ~/${name}`);
      expect(reasonOf(join(home, name, "sub"))).toBe(`it is inside ~/${name}`);
    });
  });

  it("names system dirs, and image dirs only when the path is or contains one", async () => {
    const { reasonOf } = await setup();

    expect(reasonOf("/etc")).toBe("it is /etc");
    expect(reasonOf("/var/run")).toBe("it is /var/run");
    expect(reasonOf("/dev")).toBe("it is /dev");
    expect(reasonOf("/usr/local")).toBe("it is /usr/local, which the sandbox image uses");
    expect(reasonOf("/usr")).toBe("it contains /usr/bin, which the sandbox image uses");
    expect(reasonOf("/usr/local/src/x")).toBeUndefined();
  });

  it("names the engine socket DOCKER_HOST points at, and the dir that holds it", async () => {
    const { home, reasonOf } = await setup();
    const engine = join(home, "engine");

    await mkdir(engine);

    expect(reasonOf(engine, { DOCKER_HOST: `unix://${join(engine, "docker.sock")}` })).toBe(
      "it contains the container engine socket",
    );
  });
});
