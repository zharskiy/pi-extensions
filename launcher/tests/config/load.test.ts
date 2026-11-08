import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { loadEffectiveConfig } from "../../config/index.ts";
import { createLayers } from "./fixtures.ts";

interface Layers {
  baseline?: unknown;
  policy?: (orgFile: string) => unknown;
  user?: (orgFile: string) => unknown;
  project?: unknown;
}

const loadWith = async (layers: Layers) => {
  const files = await createLayers();
  const orgFile = join(files.repoRoot, "..", "org.json");

  if (layers.baseline !== undefined) {
    await writeFile(orgFile, JSON.stringify(layers.baseline));
  }

  if (layers.policy !== undefined) {
    await files.policy(layers.policy(orgFile));
  }

  if (layers.user !== undefined) {
    await files.user(layers.user(orgFile));
  }

  if (layers.project !== undefined) {
    await files.project(layers.project);
  }

  return loadEffectiveConfig({ repoRoot: files.repoRoot, env: files.env });
};

describe("loadEffectiveConfig", () => {
  it("returns the defaults when no layer file exists", async () => {
    const { config, sources } = await loadWith({});

    expect(config).toEqual(await defaultConfig());
    expect(config.image.reference).toMatch(/^ghcr\.io\/zharskiy\/pi-sandbox:\d+\.\d+\.\d+/);
    expect(config.credentials).toEqual({ rules: [], derive: { enabled: true } });
    expect(config.egress.grants).toBe(true);
    expect(sources["egress.allow"]).toBe("default");
    expect(sources["resources.cpus"]).toBeUndefined();
  });

  it("lets the lowest layer win for keys no admin layer set and records the source per key", async () => {
    const { config, sources } = await loadWith({
      user: () => ({ resources: { cpus: 6, memoryGiB: 4 }, egress: { allow: ["crates.io"] } }),
      project: { resources: { cpus: 2 }, mounts: { cacheVolumes: ["node_modules"] } },
    });

    expect(config.resources).toEqual({ cpus: 2, memoryGiB: 4 });
    expect(config.egress.allow).toEqual(["crates.io"]);
    expect(config.mounts.cacheVolumes).toEqual(["node_modules"]);
    expect(sources).toMatchObject({
      "resources.cpus": "project",
      "resources.memoryGiB": "user",
      "egress.allow": "user",
      "mounts.cacheVolumes": "project",
    });
  });

  it("adds egress.deny and env.allow entries from every layer", async () => {
    const { config } = await loadWith({
      policy: () => ({ env: { allow: ["PAGER"] }, egress: { deny: ["paste.example.test"] } }),
      user: () => ({ env: { allow: ["EDITOR"] }, egress: { deny: ["bin.example.test"] } }),
    });

    expect(config.env.allow).toEqual(expect.arrayContaining(["TERM", "LANG", "EDITOR", "PAGER"]));
    expect(config.egress.deny).toEqual(["paste.example.test", "bin.example.test"]);
  });

  it("refuses a lower layer that sets a key the policy set, and names both layers", async () => {
    await expect(
      loadWith({ policy: () => ({ fallback: "refuse" }), user: () => ({ fallback: "refuse" }) }),
    ).rejects.toThrow("user: fallback is set by the policy config and is final there");
    await expect(
      loadWith({ policy: () => ({ resources: { cpus: 2 } }), project: { resources: { cpus: 4 } } }),
    ).rejects.toThrow("project: resources.cpus is set by the policy config and is final there");
  });

  it("refuses a project config that sets a key outside its allowlist and names the file", async () => {
    await expect(loadWith({ project: { egress: { allow: ["evil.test"] } } })).rejects.toThrow(
      /^project: egress\.allow may not be set by a project config \(.*sandbox\.json\)$/,
    );
  });

  it("names the layer and key of an invalid layer file", async () => {
    await expect(loadWith({ project: { resources: { cpus: "2" } } })).rejects.toThrow(
      "project: resources.cpus must be a number",
    );
    await expect(loadWith({ user: () => ({ ports: [3000] }) })).rejects.toThrow(
      "user: ports is not a known key",
    );
    await expect(loadWith({ policy: () => ({ egress: { blocked: [] } }) })).rejects.toThrow(
      "policy: egress.blocked is not a known key",
    );
    await expect(loadWith({ user: () => "{ not json" })).rejects.toThrow("invalid JSON");
  });
});

describe("loadEffectiveConfig with an org baseline", () => {
  it("applies the org file between policy and user and makes its keys final", async () => {
    const { config, sources } = await loadWith({
      baseline: { fallback: "refuse", egress: { allow: ["github.com"] } },
      policy: (org) => ({ org, resources: { memoryGiB: 8 } }),
      user: () => ({ resources: { cpus: 4 } }),
    });

    expect(config.fallback).toBe("refuse");
    expect(config.egress.allow).toEqual(["github.com"]);
    expect(sources).toMatchObject({ fallback: "org", "egress.allow": "org", "resources.cpus": "user" });
  });

  it("loads the org named by the user when policy names none", async () => {
    await expect(
      loadWith({ baseline: { fallback: "refuse" }, user: (org) => ({ org }) }),
    ).resolves.toMatchObject({ config: { fallback: "refuse" }, sources: { fallback: "org" } });
  });

  it("refuses a user that sets a key of the org baseline", async () => {
    await expect(
      loadWith({
        baseline: { egress: { grants: false } },
        user: (org) => ({ org, egress: { grants: true } }),
      }),
    ).rejects.toThrow("user: egress.grants is set by the org config and is final there");
  });

  it("refuses an org baseline that sets a key the policy set", async () => {
    await expect(
      loadWith({ baseline: { fallback: "host" }, policy: (org) => ({ org, fallback: "refuse" }) }),
    ).rejects.toThrow("org: fallback is set by the policy config and is final there");
  });

  it("refuses a user org when policy names one", async () => {
    await expect(
      loadWith({ baseline: {}, policy: (org) => ({ org }), user: (org) => ({ org }) }),
    ).rejects.toThrow("user: org is set by the policy config and is final there");
  });

  it("names a missing org file and refuses an org that is not an absolute path", async () => {
    await expect(loadWith({ user: (org) => ({ org }) })).rejects.toThrow(/^org: .*org\.json does not exist$/);
    await expect(loadWith({ user: () => ({ org: "https://config.example.test/org.json" }) })).rejects.toThrow(
      "user: org must be an absolute path",
    );
  });

  it("keeps the project and the org baseline from setting org", async () => {
    await expect(loadWith({ project: { org: "/etc/org.json" } })).rejects.toThrow(/^project: org may/);
    await expect(
      loadWith({ baseline: { org: "/etc/other.json" }, user: (org) => ({ org }) }),
    ).rejects.toThrow("org: org may only be set by the policy or user config");
  });
});
