import { mkdir, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostCacheDirs, resolveExtraMounts, resolveHostCaches } from "../../workspace/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const setup = async () => {
  const base = await realpath(await tempDir("mounts"));
  const home = join(base, "home");
  const repoRoot = join(home, "work", "repo");

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

  it("normalises the target, so a trailing dot, .. or slash cannot make a mount look deeper", async () => {
    const { home, context } = await setup();
    const libs = join(home, "libs");

    await mkdir(join(libs, "x"), { recursive: true });

    expect(
      resolveExtraMounts([`${libs}/.`, `${libs}/x/..`, `${libs}/`], context).map((mount) => mount.target),
    ).toEqual([libs, libs, libs]);
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

  it("refuses a link whose target is protected, judging the real path the guard is given", async () => {
    const { home, refused } = await setup();

    await mkdir(join(home, ".ssh", "keys"), { recursive: true });

    await symlink(join(home, ".ssh"), join(home, "innocent"));
    await symlink(join(home, ".ssh", "keys"), join(home, "work", "keys"));

    refused(join(home, "innocent"), "it is ~/.ssh");
    refused("~/work/keys", "it is inside ~/.ssh");
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

const cacheSetup = async () => {
  const { base, home } = await setup();
  const context = { home, env: {}, sharedCaches: [] as string[] };
  const refused = (preset: "maven" | "npm", reason: string, extra: Partial<typeof context> = {}) =>
    expect(() => resolveHostCaches([preset], { ...context, ...extra })).toThrow(`is not allowed (${reason})`);

  return { base, home, context, refused };
};

describe("resolveHostCaches", () => {
  it("binds each preset's cache folder at its real path to its guest home path", async () => {
    const { home, context } = await cacheSetup();
    const dirs = [".m2/repository", "Library/Caches/pip", ".gradle/caches", ".gradle/wrapper"];

    await Promise.all(dirs.map((dir) => mkdir(join(home, dir), { recursive: true })));

    await writeFile(join(home, ".m2", "settings.xml"), "<settings/>");

    expect(resolveHostCaches(["maven", "pip", "gradle"], context)).toEqual([
      { preset: "maven", source: join(home, ".m2/repository"), target: ".m2/repository" },
      { preset: "pip", source: join(home, "Library/Caches/pip"), target: ".cache/pip" },
      { preset: "gradle", source: join(home, ".gradle/caches"), target: ".gradle/caches" },
      { preset: "gradle", source: join(home, ".gradle/wrapper"), target: ".gradle/wrapper" },
    ]);
  });

  it("refuses ~/.m2/repository symlinked to ~/.ssh", async () => {
    const { home, refused } = await cacheSetup();

    await mkdir(join(home, ".ssh"), { recursive: true });

    await mkdir(join(home, ".m2"), { recursive: true });

    await symlink(join(home, ".ssh"), join(home, ".m2", "repository"));

    refused("maven", "it is ~/.ssh");
  });

  it("refuses a cache dir that holds settings.xml at its top level", async () => {
    const { home, refused } = await cacheSetup();

    await mkdir(join(home, ".m2", "repository", "org"), { recursive: true });

    await writeFile(join(home, ".m2", "repository", "settings.xml"), "<settings/>");

    refused("maven", "it holds settings.xml");
  });

  it("refuses a cache dir that is a link, a file, or resolves outside the home", async () => {
    const { base, home, refused } = await cacheSetup();
    const outside = join(base, "elsewhere");

    await mkdir(join(home, "real-cache"), { recursive: true });

    await mkdir(join(home, ".m2"), { recursive: true });

    await symlink(join(home, "real-cache"), join(home, ".m2", "repository"));

    await mkdir(join(outside, "_cacache"), { recursive: true });

    await symlink(outside, join(home, ".npm"));

    refused("maven", "it is a symbolic link");
    refused("npm", "it resolves outside the home directory");

    await rm(join(home, ".m2", "repository"));

    await writeFile(join(home, ".m2", "repository"), "x");

    refused("maven", "it is not a directory");
  });

  it("refuses a guest path that mounts.sharedCaches also names", async () => {
    const { home, refused } = await cacheSetup();

    await mkdir(join(home, ".m2", "repository"), { recursive: true });

    refused("maven", "~/.m2/repository is also in mounts.sharedCaches", {
      sharedCaches: ["~/.m2/repository/"],
    });
    expect(() => resolveHostCaches(["maven"], { home, env: {}, sharedCaches: ["~/.m2"] })).not.toThrow();
  });

  it("refuses a cache dir that does not exist", async () => {
    const { home, context } = await cacheSetup();

    expect(() => resolveHostCaches(["maven"], context)).toThrow(
      `mounts.hostCaches: maven (${join(home, ".m2", "repository")}) does not exist`,
    );
  });
});

describe("createHostCacheDirs", () => {
  it("creates missing cache dirs private to the user and keeps existing ones", async () => {
    const { home, context } = await cacheSetup();

    await mkdir(join(home, ".gradle", "caches", "modules-2"), { recursive: true });

    expect(createHostCacheDirs(["maven", "gradle"], context)).toEqual([
      join(home, ".m2", "repository"),
      join(home, ".gradle", "wrapper"),
    ]);
    expect((await stat(join(home, ".m2", "repository"))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(home, ".gradle", "caches"))).toEqual(["modules-2"]);
    expect(createHostCacheDirs(["maven", "gradle"], context)).toEqual([]);
    expect(resolveHostCaches(["maven"], context)).toHaveLength(1);
  });

  it("creates nothing through a parent link into a protected dir", async () => {
    const { home, context } = await cacheSetup();

    await mkdir(join(home, ".ssh"), { recursive: true });

    await symlink(join(home, ".ssh"), join(home, ".m2"));

    expect(() => createHostCacheDirs(["maven"], context)).toThrow(
      "mounts.hostCaches: maven (~/.m2/repository) is not allowed (it is inside ~/.ssh)",
    );
    expect(await readdir(join(home, ".ssh"))).toEqual([]);
  });
});
