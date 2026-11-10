import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { egressAllowList, loadEffectiveConfig } from "../../config/index.ts";
import { launcherRoot } from "../../shared/index.ts";
import { createLayers } from "./fixtures.ts";

interface Layers {
  policy?: unknown;
  user?: unknown;
}

const loadWith = async (layers: Layers) => {
  const files = await createLayers();

  if (layers.policy !== undefined) {
    await files.policy(layers.policy);
  }

  if (layers.user !== undefined) {
    await files.user(layers.user);
  }

  return loadEffectiveConfig({ env: files.env });
};

describe("loadEffectiveConfig", () => {
  it("returns the defaults when no layer file exists", async () => {
    const { config, sources } = await loadWith({});

    expect(config).toEqual(defaultConfig());
    expect(config.image).toEqual({});
    expect(config.credentials).toEqual({ rules: [], derive: { enabled: true } });
    expect(config.egress.grants).toBe(true);
    expect(sources["egress.allow"]).toBe("default");
    expect(sources["resources.cpus"]).toBeUndefined();
  });

  it("allows the npm, pypi and github registry hosts by default through egress.presets", async () => {
    const { config, sources } = await loadWith({});

    expect(config.egress.allow).toEqual([]);
    expect(sources["egress.presets"]).toBe("default");
    expect(egressAllowList(config.egress)).toEqual([
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "repo.yarnpkg.com",
      "pypi.org",
      "files.pythonhosted.org",
      "github.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
      "raw.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ]);
  });

  it("expands the user's presets ahead of egress.allow without duplicates", async () => {
    const { config } = await loadWith({
      user: { egress: { presets: ["maven", "go"], allow: ["repo1.maven.org", "corp.test"] } },
    });

    expect(egressAllowList(config.egress)).toEqual([
      "repo.maven.apache.org",
      "repo1.maven.org",
      "proxy.golang.org",
      "sum.golang.org",
      "corp.test",
    ]);
  });

  it("lets Gradle plugins resolve through the gradle preset, artifact host included", async () => {
    const { config } = await loadWith({ user: { egress: { presets: ["gradle"] } } });

    expect(egressAllowList(config.egress)).toEqual([
      "plugins.gradle.org",
      "plugins-artifacts.gradle.org",
      "services.gradle.org",
      "downloads.gradle.org",
    ]);
  });

  it("lets the policy turn the presets off for good", async () => {
    const { config } = await loadWith({ policy: { egress: { presets: [] } } });

    expect(egressAllowList(config.egress)).toEqual([]);
    const kept = await loadWith({
      policy: { egress: { presets: [] } },
      user: { egress: { presets: ["npm"] } },
    });

    expect(egressAllowList(kept.config.egress)).toEqual([]);
    expect(kept.ignored).toEqual([
      { layer: "user", key: "egress.presets", reason: "final in the policy config" },
    ]);
  });

  it("refuses to forward JAVA_TOOL_OPTIONS, which carries the sandbox proxy", async () => {
    await expect(loadWith({ user: { env: { allow: ["JAVA_TOOL_OPTIONS"] } } })).rejects.toThrow(
      "user: env.allow[0] JAVA_TOOL_OPTIONS is set by the launcher and is not forwarded",
    );
  });

  it("refuses an unknown preset", async () => {
    await expect(loadWith({ user: { egress: { presets: ["apt"] } } })).rejects.toThrow("egress.presets[0]");
  });

  it("lets the user set keys the policy left open and records the source per key", async () => {
    const { config, sources } = await loadWith({
      policy: { resources: { memoryGiB: 8 } },
      user: { resources: { cpus: 6 }, egress: { allow: ["crates.io"] } },
    });

    expect(config.resources).toEqual({ cpus: 6, memoryGiB: 8 });
    expect(config.egress.allow).toEqual(["crates.io"]);
    expect(sources).toMatchObject({
      "resources.cpus": "user",
      "resources.memoryGiB": "policy",
      "egress.allow": "user",
    });
  });

  it("adds egress.deny and env.allow entries from every layer", async () => {
    const { config } = await loadWith({
      policy: { env: { allow: ["PAGER"] }, egress: { deny: ["paste.example.test"] } },
      user: { env: { allow: ["EDITOR"] }, egress: { deny: ["bin.example.test"] } },
    });

    expect(config.env.allow).toEqual(expect.arrayContaining(["TERM", "LANG", "EDITOR", "PAGER"]));
    expect(config.egress.deny).toEqual(["paste.example.test", "bin.example.test"]);
  });

  it("ignores a user key the policy set", async () => {
    const ignored = await loadWith({
      policy: { fallback: "refuse", resources: { cpus: 2 } },
      user: { fallback: "host", resources: { cpus: 4 } },
    });

    expect(ignored.config.fallback).toBe("refuse");
    expect(ignored.config.resources.cpus).toBe(2);
    expect(ignored.ignored.map((entry) => `${entry.layer}: ${entry.key} (${entry.reason})`)).toEqual([
      "user: fallback (final in the policy config)",
      "user: resources.cpus (final in the policy config)",
    ]);
  });

  it("names the layer and key of an invalid layer file", async () => {
    await expect(loadWith({ user: { resources: { cpus: "2" } } })).rejects.toThrow(
      "user: resources.cpus must be a number",
    );
    await expect(loadWith({ user: { ports: [3000] } })).rejects.toThrow("user: ports is not a known key");
    await expect(loadWith({ policy: { egress: { blocked: [] } } })).rejects.toThrow(
      "policy: egress.blocked is not a known key",
    );
    await expect(loadWith({ user: "{ not json" })).rejects.toThrow("invalid JSON");
  });
});

describe("loadEffectiveConfig with the example policy", () => {
  it("locks egress for the README's Java user config and keeps the rest of it", async () => {
    const policy = JSON.parse(await readFile(join(launcherRoot(), "examples", "policy.json"), "utf8")) as {
      egress: { allow: string[] };
    };
    const { config, ignored } = await loadWith({
      policy,
      user: {
        egress: { presets: ["npm", "pypi", "github", "maven", "gradle"], allow: ["registry.corp.example"] },
        image: { packages: ["openjdk-17-jdk-headless", "maven"] },
      },
    });

    expect(ignored).toEqual([
      {
        layer: "user",
        key: "egress.allow",
        reason: "egress is locked: the policy config sets egress.grants to false",
      },
    ]);
    expect(config.egress.allow).toEqual(policy.egress.allow);
    expect(config.egress.presets).toEqual(["npm", "pypi", "github", "maven", "gradle"]);
    expect(config.image.packages).toEqual(["openjdk-17-jdk-headless", "maven"]);
    expect(config.credentials.derive.enabled).toBe(true);
    expect(config.egress.grants).toBe(false);
  });
});
