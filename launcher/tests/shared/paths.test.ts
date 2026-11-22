import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  expandHome,
  isWithin,
  launcherEntry,
  launcherPaths,
  launcherRoot,
  realOrResolved,
  realOrResolvedSync,
} from "../../shared/index.ts";

const home = "/home/dev";

const sourceRoot = resolve(import.meta.dirname, "..", "..");

const compiledModule = pathToFileURL("/opt/pkg/launcher/dist/shared/paths.js").href;

describe("launcherPaths", () => {
  it("keeps the config and the state under pi's default agent dir", () => {
    expect(launcherPaths({ env: {}, home })).toEqual({
      stateDir: "/home/dev/.pi/agent/pi-sandbox/state",
      userConfigFile: "/home/dev/.pi/agent/pi-sandbox/config.json",
    });
  });

  it("lets the environment override every path", () => {
    const temp = realpathSync.native(tmpdir());
    const env = {
      PI_SANDBOX_STATE_DIR: join(temp, "pi-sandbox-state"),
      PI_SANDBOX_USER_CONFIG: "/tmp/user.json",
    };

    expect(launcherPaths({ env, home })).toEqual({
      stateDir: join(temp, "pi-sandbox-state"),
      userConfigFile: "/tmp/user.json",
    });
  });

  it("spells a state dir with a trailing slash like the dir itself", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-sandbox-state-"));
    const stateDir = join(parent, "state");

    await mkdir(stateDir);

    expect(launcherPaths({ env: { PI_SANDBOX_STATE_DIR: `${stateDir}/` }, home }).stateDir).toBe(
      realpathSync.native(stateDir),
    );
    expect(
      launcherPaths({ env: { PI_SANDBOX_STATE_DIR: join(parent, "missing", "..", "state") }, home }).stateDir,
    ).toBe(realpathSync.native(stateDir));
  });

  it("spells a state dir reached through a symlink like its target", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-sandbox-state-"));
    const stateDir = join(parent, "state");

    await mkdir(stateDir);

    await symlink(stateDir, join(parent, "alias"));

    expect(launcherPaths({ env: { PI_SANDBOX_STATE_DIR: join(parent, "alias") }, home }).stateDir).toBe(
      realpathSync.native(stateDir),
    );
    expect(
      launcherPaths({ env: { PI_SANDBOX_STATE_DIR: join(parent, "alias", "not-yet") }, home }).stateDir,
    ).toBe(join(realpathSync.native(stateDir), "not-yet"));
  });

  it("creates nothing when it resolves a state dir that does not exist", async () => {
    const parent = realpathSync.native(await mkdtemp(join(tmpdir(), "pi-sandbox-state-")));
    const stateDir = join(parent, "missing", "state");

    expect(launcherPaths({ env: { PI_SANDBOX_STATE_DIR: stateDir }, home }).stateDir).toBe(stateDir);
    expect(existsSync(join(parent, "missing"))).toBe(false);
  });

  it("resolves a relative state dir against the working directory, so two directories give two state dirs", async () => {
    const first = realpathSync.native(await mkdtemp(join(tmpdir(), "pi-sandbox-cwd-")));
    const second = realpathSync.native(await mkdtemp(join(tmpdir(), "pi-sandbox-cwd-")));
    const env = { PI_SANDBOX_STATE_DIR: "state" };
    const cwd = vi.spyOn(process, "cwd");

    cwd.mockReturnValue(first);

    const fromFirst = launcherPaths({ env, home }).stateDir;

    cwd.mockReturnValue(second);

    const fromSecond = launcherPaths({ env, home }).stateDir;

    cwd.mockRestore();

    expect([fromFirst, fromSecond]).toEqual([join(first, "state"), join(second, "state")]);
  });

  it("ignores empty overrides", () => {
    const env = { PI_SANDBOX_USER_CONFIG: "" };

    expect(launcherPaths({ env, home }).userConfigFile).toBe("/home/dev/.pi/agent/pi-sandbox/config.json");
  });

  it("follows pi's agent dir for the config and the state", () => {
    const env = { PI_CODING_AGENT_DIR: "~/work/agent" };

    expect(launcherPaths({ env, home })).toMatchObject({
      stateDir: "/home/dev/work/agent/pi-sandbox/state",
      userConfigFile: "/home/dev/work/agent/pi-sandbox/config.json",
    });
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/ and leaves other paths alone", () => {
    expect(expandHome("~", home)).toBe(home);
    expect(expandHome("~/work", home)).toBe("/home/dev/work");
    expect(expandHome("/opt/~/x", home)).toBe("/opt/~/x");
  });
});

describe("isWithin", () => {
  it("accepts the parent itself and paths below it, nothing else", () => {
    expect(isWithin("/work", "/work")).toBe(true);
    expect(isWithin("/work/repo", "/work")).toBe(true);
    expect(isWithin("/workshop", "/work")).toBe(false);
    expect(isWithin("/", "/work")).toBe(false);
  });
});

describe("launcherRoot", () => {
  it("finds the launcher folder when running from source", () => {
    expect(launcherRoot()).toBe(sourceRoot);
    expect(existsSync(join(launcherRoot(), "shared", "paths.ts"))).toBe(true);
  });

  it("finds the launcher folder above dist when running compiled", () => {
    expect(launcherRoot(compiledModule)).toBe("/opt/pkg/launcher");
  });
});

describe("launcherEntry", () => {
  it("returns the source file when running from source", () => {
    expect(launcherEntry("proxy/daemon.ts")).toBe(join(sourceRoot, "proxy", "daemon.ts"));
  });

  it("returns the compiled file under dist when running compiled", () => {
    expect(launcherEntry("proxy/daemon.ts", compiledModule)).toBe("/opt/pkg/launcher/dist/proxy/daemon.js");
  });
});

describe("realOrResolved", () => {
  it("resolves symlinks of an existing path and falls back to the absolute path", async () => {
    const missing = join("relative", "missing-path");
    const real = realpathSync.native(tmpdir());

    expect(await realOrResolved(tmpdir())).toBe(real);
    expect(realOrResolvedSync(tmpdir())).toBe(real);
    expect(await realOrResolved(missing)).toBe(resolve(missing));
    expect(realOrResolvedSync(missing)).toBe(resolve(missing));
  });
});
