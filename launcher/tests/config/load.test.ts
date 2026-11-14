import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { egressAllowList, loadEffectiveConfig } from "../../config/index.ts";
import { launcherRoot } from "../../shared/index.ts";
import { createConfigFile } from "./fixtures.ts";

const loadWith = async (config?: unknown) => {
  const file = await createConfigFile();

  if (config !== undefined) {
    await file.write(config);
  }

  return loadEffectiveConfig({ env: file.env });
};

describe("loadEffectiveConfig", () => {
  it("returns the defaults when no config file exists", async () => {
    const { config, sources } = await loadWith();

    expect(config).toEqual(defaultConfig());
    expect(config.image).toEqual({});
    expect(config.credentials).toEqual({ rules: [], derive: { enabled: true } });
    expect(sources["egress.allow"]).toBe("default");
    expect(sources["resources.cpus"]).toBeUndefined();
  });

  it("allows only pi.dev by default", async () => {
    const { config } = await loadWith();

    expect(config.egress.allow).toEqual([]);
    expect(egressAllowList(config.egress)).toEqual(["pi.dev"]);
  });

  it("puts egress.allow after pi.dev without duplicates", async () => {
    const { config } = await loadWith({ egress: { allow: ["pi.dev", "repo1.maven.org", "corp.test"] } });

    expect(egressAllowList(config.egress)).toEqual(["pi.dev", "repo1.maven.org", "corp.test"]);
  });

  it("refuses to forward JAVA_TOOL_OPTIONS, which carries the sandbox proxy", async () => {
    await expect(loadWith({ env: { allow: ["JAVA_TOOL_OPTIONS"] } })).rejects.toThrow(
      "config: env.allow[0] JAVA_TOOL_OPTIONS is set by the launcher and is not forwarded",
    );
  });

  it("refuses the removed keys", async () => {
    await expect(loadWith({ egress: { presets: ["npm"] } })).rejects.toThrow(
      "config: egress.presets was removed; list the hosts in egress.allow, see REMOVED-DEFAULTS.md",
    );
    await expect(loadWith({ egress: { grants: false } })).rejects.toThrow(
      "config: egress.grants was removed; grants are always on",
    );
    await expect(loadWith({ egress: { parentProxy: "none" } })).rejects.toThrow(
      "config: egress.parentProxy was removed; the parent proxy is always taken from the environment",
    );
    await expect(loadWith({ fallback: "refuse" })).rejects.toThrow(
      "config: fallback was removed; --no-sandbox is always available",
    );
  });

  it("records the source per key", async () => {
    const { config, sources } = await loadWith({ resources: { cpus: 6 }, egress: { allow: ["crates.io"] } });

    expect(config.resources).toEqual({ cpus: 6 });
    expect(config.egress.allow).toEqual(["crates.io"]);
    expect(sources).toMatchObject({
      "resources.cpus": "config",
      "egress.allow": "config",
      "egress.deny": "default",
    });
    expect(sources["resources.memoryGiB"]).toBeUndefined();
  });

  it("adds env.allow to the default terminal variables", async () => {
    const { config } = await loadWith({ env: { allow: ["EDITOR"] }, egress: { deny: ["bin.example.test"] } });

    expect(config.env.allow).toEqual(expect.arrayContaining(["TERM", "LANG", "EDITOR"]));
    expect(config.egress.deny).toEqual(["bin.example.test"]);
  });

  it("names the key of an invalid config file and points at the file", async () => {
    const file = await createConfigFile();

    await file.write({ resources: { cpus: "2" } });

    await expect(loadEffectiveConfig({ env: file.env })).rejects.toMatchObject({
      message: "config: resources.cpus must be a number",
      hint: `fix ${file.userFile}`,
    });
    await expect(loadWith({ ports: [3000] })).rejects.toThrow("config: ports is not a known key");
    await expect(loadWith({ egress: { blocked: [] } })).rejects.toThrow(
      "config: egress.blocked is not a known key",
    );
    await expect(loadWith("{ not json")).rejects.toThrow("invalid JSON");
  });
});

describe("loadEffectiveConfig with the example config", () => {
  it("loads examples/config.json and keeps every key it sets", async () => {
    const example = JSON.parse(await readFile(join(launcherRoot(), "examples", "config.json"), "utf8")) as {
      egress: { allow: string[]; deny: string[]; privateHosts: string[] };
      credentials: { rules: unknown[] };
    };
    const { config } = await loadWith(example);

    expect(config.egress).toEqual(example.egress);
    expect(config.credentials.rules).toEqual(example.credentials.rules);
    expect(config.credentials.derive.enabled).toBe(true);
    expect(config.tls.extraCa).toEqual([
      { sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
    ]);
  });
});
