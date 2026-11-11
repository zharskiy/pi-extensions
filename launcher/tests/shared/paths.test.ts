import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
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

const missing = () => false;

const sourceRoot = resolve(import.meta.dirname, "..", "..");

const compiledModule = pathToFileURL("/opt/pkg/launcher/dist/shared/paths.js").href;

describe("launcherPaths", () => {
  it("uses the macOS policy location on darwin", () => {
    expect(launcherPaths({ env: {}, platform: "darwin", home, fileExists: missing })).toEqual({
      stateDir: "/home/dev/.local/state/pi-sandbox",
      userConfigFile: "/home/dev/.config/pi-sandbox/config.json",
      policyFile: "/Library/Application Support/pi-sandbox/policy.json",
    });
  });

  it("uses /etc for the policy on linux", () => {
    expect(launcherPaths({ env: {}, platform: "linux", home, fileExists: missing }).policyFile).toBe(
      "/etc/pi-sandbox/policy.json",
    );
  });

  it("lets the environment override every path", () => {
    const env = {
      PI_SANDBOX_STATE_DIR: "/tmp/state",
      PI_SANDBOX_USER_CONFIG: "/tmp/user.json",
      PI_SANDBOX_POLICY_FILE: "/tmp/policy.json",
    };

    expect(launcherPaths({ env, platform: "darwin", home, fileExists: missing })).toEqual({
      stateDir: "/tmp/state",
      userConfigFile: "/tmp/user.json",
      policyFile: "/tmp/policy.json",
    });
  });

  it("ignores the policy override when the standard policy file exists", () => {
    const standard = "/Library/Application Support/pi-sandbox/policy.json";
    const env = { PI_SANDBOX_POLICY_FILE: "/tmp/policy.json" };
    const paths = launcherPaths({ env, platform: "darwin", home, fileExists: (path) => path === standard });

    expect(paths.policyFile).toBe(standard);
  });

  it("ignores empty overrides", () => {
    const env = { PI_SANDBOX_USER_CONFIG: "" };

    expect(launcherPaths({ env, platform: "linux", home }).userConfigFile).toBe(
      "/home/dev/.config/pi-sandbox/config.json",
    );
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
