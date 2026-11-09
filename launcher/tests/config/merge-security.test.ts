import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { getPath, setPath } from "../../config/dotted.ts";
import { ignoredNotice, mergeLayers } from "../../config/merge.ts";
import type { LayerConfig, LayerName } from "../../config/types.ts";
import { layerKeys, validateLayer } from "../../config/validate.ts";
import { isJsonObject } from "../../shared/index.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

const merge = async (layers: Layers) => mergeLayers({ defaults: await defaultConfig(), layers });

const ignoredKeys = async (layers: Layers) =>
  (await merge(layers)).ignored.map((entry) => `${entry.layer}: ${entry.key} (${entry.reason})`);

const COMPLETE_LAYER: LayerConfig = {
  fallback: "refuse",
  image: {
    reference: "registry.corp.test/pi",
    digest: `sha256:${"d".repeat(64)}`,
    packages: ["chromium"],
    npmGlobal: ["tool@1.0.0"],
    dockerfile: "/etc/pi-sandbox/layer.Dockerfile",
  },
  credentials: {
    rules: [
      {
        id: "llm",
        host: "llm.corp.test",
        placeholder: "pi-sandbox-llm",
        secret: { env: "LLM_KEY" },
      },
    ],
    derive: { enabled: false, hosts: ["*.corp.test"] },
  },
  egress: {
    allow: ["llm.corp.test"],
    presets: ["maven"],
    deny: ["paste.corp.test"],
    privateHosts: ["*.corp.internal"],
    parentProxy: "none",
    grants: false,
  },
  tls: { extraCa: [{ file: "/etc/corp/ca.pem" }] },
  workspaceRoots: { roots: ["/work"], outside: "refuse" },
  mounts: {
    extraReadOnly: ["/opt/tools"],
    cacheVolumes: ["node_modules"],
    sharedCaches: ["~/.cache/pip"],
    hostCaches: ["maven"],
    autoOverlays: false,
  },
  env: { allow: ["EDITOR"] },
  resources: { cpus: 2, memoryGiB: 4 },
  sessions: { host: false },
  org: "/etc/pi-sandbox/org.json",
};

const UNION_KEYS = [
  "egress.allow",
  "egress.deny",
  "egress.privateHosts",
  "image.packages",
  "credentials.rules",
  "env.allow",
];

const settableKeys = () => layerKeys().filter((key) => key !== "$schema" && !key.includes("[]"));

const leafKeys = () => [
  ...settableKeys().filter((key) => {
    const value = getPath(COMPLETE_LAYER, key);

    return value !== undefined && !isJsonObject(value) && !key.startsWith("workspaceRoots.");
  }),
  "workspaceRoots",
];

describe("mergeLayers with a layer that sets every key", () => {
  it("is a valid user layer that sets every key", () => {
    expect(validateLayer(COMPLETE_LAYER, "user")).toEqual(COMPLETE_LAYER);
    expect(settableKeys().filter((key) => getPath(COMPLETE_LAYER, key) === undefined)).toEqual([]);
  });

  it("carries every key into the merged config with the user as its source", async () => {
    const { config, sources } = await merge({ user: COMPLETE_LAYER });

    leafKeys().forEach((key) => {
      const expected = getPath(COMPLETE_LAYER, key);

      expect({ key, merged: getPath(config, key), source: sources[key] }).toEqual({
        key,
        merged: UNION_KEYS.includes(key) ? expect.arrayContaining(expected as unknown[]) : expected,
        source: "user",
      });
    });
  });
});

describe("mergeLayers with keys of the policy and org layers", () => {
  it("ignores every key the policy sets in the org and user layers, except the unions, and keeps the policy value", async () => {
    const results = await Promise.all(
      leafKeys()
        .filter((key) => key !== "org")
        .map(async (key) => {
          const layer = setPath({}, key, getPath(COMPLETE_LAYER, key)) as LayerConfig;
          const merged = await merge({ policy: layer, org: layer, user: layer });

          return {
            key,
            ignored: merged.ignored.map((entry) => `${entry.layer}: ${entry.key} (${entry.reason})`),
            source: merged.sources[key],
          };
        }),
    );

    expect(results).toEqual(
      results.map(({ key }) =>
        UNION_KEYS.includes(key)
          ? { key, ignored: [], source: "user" }
          : {
              key,
              ignored: [
                `org: ${key} (final in the policy config)`,
                `user: ${key} (final in the policy config)`,
              ],
              source: "policy",
            },
      ),
    );
  });

  it("ignores the org keys in the user and the project and reports every one", async () => {
    expect(
      await ignoredKeys({
        org: { egress: { grants: false, presets: ["npm"] }, mounts: { autoOverlays: true } },
        user: { egress: { grants: true, presets: ["maven"] } },
        project: { mounts: { autoOverlays: false } },
      }),
    ).toEqual([
      "user: egress.presets (final in the org config)",
      "user: egress.grants (final in the org config)",
      "project: mounts.autoOverlays (final in the org config)",
    ]);
  });

  it("adds the entries of every layer to the union keys and lets none remove one", async () => {
    const orgRule = {
      id: "corp",
      host: "llm.corp.test",
      placeholder: "pi-sandbox-corp",
      secret: { env: "CORP" },
    };
    const userRule = {
      id: "mine",
      host: "git.mine.test",
      placeholder: "pi-sandbox-mine",
      secret: { env: "MINE" },
    };
    const { config, ignored } = await merge({
      org: {
        egress: { allow: ["registry.corp.test"], privateHosts: ["registry.corp.test"] },
        image: { packages: ["jq"] },
        credentials: { rules: [orgRule] },
      },
      user: {
        egress: { allow: [], privateHosts: ["git.mine.test"] },
        image: { packages: ["maven", "jq"] },
        credentials: { rules: [userRule] },
      },
    });

    expect(config.egress.allow).toEqual(["registry.corp.test"]);
    expect(config.egress.privateHosts).toEqual(["registry.corp.test", "git.mine.test"]);
    expect(config.image.packages).toEqual(["jq", "maven"]);
    expect(config.credentials.rules).toEqual([orgRule, userRule]);
    expect(ignored).toEqual([]);
  });

  it("keeps the higher layer's rule when a lower layer reuses its id", async () => {
    const orgRule = {
      id: "corp",
      host: "llm.corp.test",
      placeholder: "pi-sandbox-corp",
      secret: { env: "CORP" },
    };
    const { config, ignored } = await merge({
      org: { credentials: { rules: [orgRule] } },
      user: { credentials: { rules: [{ ...orgRule, host: "evil.test" }] } },
    });

    expect(config.credentials.rules).toEqual([orgRule]);
    expect(ignored).toEqual([
      { layer: "user", key: "credentials.rules corp", reason: "a higher layer has a rule with this id" },
    ]);
  });

  it("names every ignored key and layer in one warning", () => {
    expect(
      ignoredNotice([
        { layer: "user", key: "egress.presets", reason: "final in the org config" },
        { layer: "user", key: "egress.grants", reason: "final in the org config" },
        {
          layer: "project",
          key: "egress.allow",
          reason: "a project config may set only mounts.cacheVolumes",
        },
      ]),
    ).toEqual([
      "pi-sandbox: warning: config keys ignored: user egress.presets, egress.grants (final in the org config); project egress.allow (a project config may set only mounts.cacheVolumes); see pi sandbox config",
    ]);
    expect(ignoredNotice([])).toEqual([]);
  });

  it("lets a lower layer set a sibling key the admin layers left open", async () => {
    const { config, sources } = await merge({
      policy: { credentials: { derive: { enabled: true } } },
      user: { credentials: { derive: { hosts: ["*.corp.test"] } } },
    });

    expect(config.credentials.derive).toEqual({ enabled: true, hosts: ["*.corp.test"] });
    expect(sources).toMatchObject({
      "credentials.derive.enabled": "policy",
      "credentials.derive.hosts": "user",
    });
  });

  it("unions egress.deny and env.allow across the layers", async () => {
    const { config } = await merge({
      policy: { egress: { deny: ["a.test"] }, env: { allow: ["PAGER"] } },
      org: { egress: { deny: ["b.test"] } },
      user: { egress: { deny: ["a.test", "c.test"] }, env: { allow: ["EDITOR"] } },
    });

    expect(config.egress.deny).toEqual(["a.test", "b.test", "c.test"]);
    expect(config.env.allow).toEqual(expect.arrayContaining(["PAGER", "EDITOR", "TERM"]));
  });
});
