import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveExtraMounts } from "../../workspace/index.ts";

const created: string[] = [];

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));

  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const setup = async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-mounts-")));
  const home = join(base, "home");
  const repoRoot = join(home, "work", "repo");

  created.push(base);

  await mkdir(repoRoot, { recursive: true });

  const context: Parameters<typeof resolveExtraMounts>[1] = { home, env: {}, repoRoot };
  const refused = (path: string, reason: string, extra: Partial<typeof context> = {}) =>
    expect(() => resolveExtraMounts([path], { ...context, ...extra })).toThrow(
      `mounts.extraReadOnly: ${path} is not allowed (${reason})`,
    );

  return { base, home, repoRoot, context, refused };
};

const listen = (path: string) =>
  new Promise<void>((resolve) => {
    const server = createServer();

    servers.push(server);

    server.listen(path, () => resolve());
  });

describe("resolveExtraMounts", () => {
  it("binds an existing directory or file under the home at its real path, with ~ expanded", async () => {
    const { home, context } = await setup();
    const libs = join(home, "libs");

    await mkdir(join(libs, "sdk"), { recursive: true });

    await writeFile(join(home, "tool.cfg"), "x");

    await symlink(join(libs, "sdk"), join(home, "sdk-link"));

    expect(resolveExtraMounts(["~/libs", join(home, "tool.cfg"), "~/sdk-link"], context)).toEqual([
      { source: libs, target: libs },
      { source: join(home, "tool.cfg"), target: join(home, "tool.cfg") },
      { source: join(libs, "sdk"), target: join(home, "sdk-link") },
    ]);
  });

  it("refuses a missing path and anything that is not a regular file or directory", async () => {
    const { home, refused } = await setup();
    const socket = join(home, "agent.sock");

    await listen(socket);

    refused(join(home, "missing"), "it does not exist");
    refused(socket, "it is not a regular file or directory");
    refused("/dev/null", "it is not a regular file or directory");
  });

  it("refuses the home itself and anything that contains it", async () => {
    const { base, home, refused } = await setup();

    refused("~", "it is the home directory");
    refused(home, "it is the home directory");
    refused(base, "it contains the home directory");
    refused("/", "it contains the home directory");
  });

  it("refuses pi's dir, the configured agent dir, the state dir and the user config", async () => {
    const { base, home, refused } = await setup();
    const agent = join(base, "agent");
    const state = join(base, "state");

    await mkdir(join(home, ".pi", "agent"), { recursive: true });

    await mkdir(join(agent, "skills"), { recursive: true });

    await mkdir(join(state, "proxy"), { recursive: true });

    await mkdir(join(home, ".config", "pi-sandbox"), { recursive: true });

    await writeFile(join(home, ".config", "pi-sandbox", "config.json"), "{}");

    refused(join(home, ".pi"), "it is pi's directory");
    refused(join(home, ".pi", "agent"), "it is inside pi's directory");
    refused(join(agent, "skills"), "it is inside pi's agent directory", {
      env: { PI_CODING_AGENT_DIR: agent },
    });
    refused(join(state, "proxy"), "it is inside the launcher state directory", {
      env: { PI_SANDBOX_STATE_DIR: state },
    });
    refused(join(home, ".config"), "it contains the launcher user config");
  });

  it("refuses credential and engine dirs in the home", async () => {
    const { home, refused } = await setup();
    const names = [".ssh", ".gnupg", ".aws", ".docker", ".colima", ".kube"];

    await Promise.all(names.map((name) => mkdir(join(home, name, "sub"), { recursive: true })));

    names.forEach((name) => {
      refused(join(home, name), `it is ~/${name}`);
      refused(join(home, name, "sub"), `it is inside ~/${name}`);
    });
  });

  it("refuses system dirs", async () => {
    const { refused } = await setup();

    refused("/etc", "it is /etc");
    refused("/var/run", "it is /var/run");
    refused("/dev", "it is /dev");
  });

  it("refuses a .git dir, a path inside one and a checkout that holds one", async () => {
    const { home, refused } = await setup();
    const checkout = join(home, "libs", "sdk");

    await mkdir(join(checkout, ".git", "objects"), { recursive: true });

    refused(join(checkout, ".git"), "it is inside a .git directory");
    refused(join(checkout, ".git", "objects"), "it is inside a .git directory");
    refused(checkout, "it contains a .git directory");
  });

  it("refuses the engine socket from DOCKER_HOST or the backend, and the dir that holds it", async () => {
    const { home, refused } = await setup();
    const engine = join(home, "engine");
    const socket = join(engine, "docker.sock");

    await mkdir(engine, { recursive: true });

    await writeFile(join(engine, "notes.txt"), "x");

    refused(engine, "it contains the container engine socket", { env: { DOCKER_HOST: `unix://${socket}` } });
    refused(engine, "it contains the container engine socket", { engineSockets: [socket] });
  });
});
