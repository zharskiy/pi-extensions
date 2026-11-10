import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { getPath, setPath } from "../../config/dotted.ts";
import { ignoredNotice, mergeLayers } from "../../config/merge.ts";
import type { LayerConfig, LayerName } from "../../config/types.ts";
import { layerKeys, validateLayer } from "../../config/validate.ts";
import { isJsonObject } from "../../shared/index.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

const merge = (layers: Layers) => mergeLayers({ defaults: defaultConfig(), layers });

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
  workspaceRoots: { roots: ["/work"] },
  mounts: { sharedCaches: ["~/.cache/pip"], autoOverlays: false },
  env: { allow: ["EDITOR"] },
  resources: { cpus: 2, memoryGiB: 4 },
  sessions: { host: false },
};

const UNION_KEYS = [
  "egress.allow",
  "egress.deny",
  "egress.privateHosts",
  "image.packages",
  "image.npmGlobal",
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

const ORG_RULE = {
  id: "corp",
  host: "llm.corp.test",
  placeholder: "pi-sandbox-corp",
  secret: { env: "CORP" },
};

describe("mergeLayers with keys of the policy layer", () => {
  it("ignores every key the policy sets in the user layer, except the unions, and keeps the policy value", async () => {
    const results = await Promise.all(
      leafKeys().map(async (key) => {
        const layer = setPath({}, key, getPath(COMPLETE_LAYER, key)) as LayerConfig;
        const merged = await merge({ policy: layer, user: layer });

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
          ? { key, ignored: [], source: "policy" }
          : { key, ignored: [`user: ${key} (final in the policy config)`], source: "policy" },
      ),
    );
  });

  it("ignores the policy keys in the user config and reports every one", async () => {
    expect(
      await ignoredKeys({
        policy: { egress: { grants: true, presets: ["npm"] }, mounts: { autoOverlays: true } },
        user: { egress: { grants: false, presets: ["maven"] }, mounts: { autoOverlays: false } },
      }),
    ).toEqual([
      "user: egress.presets (final in the policy config)",
      "user: egress.grants (final in the policy config)",
      "user: mounts.autoOverlays (final in the policy config)",
    ]);
  });

  it("adds the entries of every layer to the union keys, lets none remove one and names every layer that added", async () => {
    const userRule = {
      id: "mine",
      host: "git.mine.test",
      placeholder: "pi-sandbox-mine",
      secret: { env: "MINE" },
    };
    const { config, ignored, sources } = await merge({
      policy: {
        egress: { allow: ["registry.corp.test"], privateHosts: ["registry.corp.test"] },
        image: { packages: ["jq"], npmGlobal: ["corp-cli@1.0.0"] },
        credentials: { rules: [ORG_RULE] },
      },
      user: {
        egress: { allow: [], privateHosts: ["git.mine.test"] },
        image: { packages: ["maven", "jq"], npmGlobal: ["tool@2.0.0"] },
        credentials: { rules: [userRule] },
      },
    });

    expect(config.egress.allow).toEqual(["registry.corp.test"]);
    expect(config.egress.privateHosts).toEqual(["registry.corp.test", "git.mine.test"]);
    expect(config.image.packages).toEqual(["jq", "maven"]);
    expect(config.image.npmGlobal).toEqual(["corp-cli@1.0.0", "tool@2.0.0"]);
    expect(config.credentials.rules).toEqual([ORG_RULE, userRule]);
    expect(ignored).toEqual([]);
    expect(sources).toMatchObject({
      "egress.allow": "policy",
      "egress.privateHosts": "policy+user",
      "image.npmGlobal": "policy+user",
      "credentials.rules": "policy+user",
    });
  });

  it("locks egress when the policy turns grants off: the user's hosts and private hosts are ignored", async () => {
    const { config, ignored, sources } = await merge({
      policy: { egress: { grants: false, allow: ["registry.corp.test"] } },
      user: {
        egress: { allow: ["mine.test"], privateHosts: ["git.mine.test"], deny: ["paste.test"] },
        image: { packages: ["jq"] },
      },
    });

    expect(config.egress.allow).toEqual(["registry.corp.test"]);
    expect(config.egress.privateHosts).toEqual([]);
    expect(config.egress.deny).toEqual(["paste.test"]);
    expect(config.image.packages).toEqual(["jq"]);
    expect(sources["egress.allow"]).toBe("policy");
    expect(ignored).toEqual([
      {
        layer: "user",
        key: "egress.allow",
        reason: "egress is locked: the policy config sets egress.grants to false",
      },
      {
        layer: "user",
        key: "egress.privateHosts",
        reason: "egress is locked: the policy config sets egress.grants to false",
      },
    ]);
  });

  it("does not lock egress when grants are off only in the user config", async () => {
    const { config, ignored } = await merge({
      policy: { egress: { allow: ["registry.corp.test"] } },
      user: { egress: { grants: false, allow: ["mine.test"] } },
    });

    expect(config.egress.allow).toEqual(["registry.corp.test", "mine.test"]);
    expect(config.egress.grants).toBe(false);
    expect(ignored).toEqual([]);
  });

  it("keeps the higher layer's rule when a lower layer reuses its id", async () => {
    const { config, ignored } = await merge({
      policy: { credentials: { rules: [ORG_RULE] } },
      user: { credentials: { rules: [{ ...ORG_RULE, host: "evil.test" }] } },
    });

    expect(config.credentials.rules).toEqual([ORG_RULE]);
    expect(ignored).toEqual([
      { layer: "user", key: "credentials.rules corp", reason: "a higher layer has a rule with this id" },
    ]);
  });

  it("names every ignored key and layer in one warning", () => {
    expect(
      ignoredNotice([
        { layer: "user", key: "egress.presets", reason: "final in the policy config" },
        { layer: "user", key: "egress.grants", reason: "final in the policy config" },
        {
          layer: "user",
          key: "egress.allow",
          reason: "egress is locked: the policy config sets egress.grants to false",
        },
      ]),
    ).toEqual([
      "pi-sandbox: warning: config keys ignored: user egress.presets, egress.grants (final in the policy config); user egress.allow (egress is locked: the policy config sets egress.grants to false); see pi sandbox config",
    ]);
    expect(ignoredNotice([])).toEqual([]);
  });

  it("lets a lower layer set a sibling key the policy left open", async () => {
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
      policy: { egress: { deny: ["a.test", "b.test"] }, env: { allow: ["PAGER"] } },
      user: { egress: { deny: ["a.test", "c.test"] }, env: { allow: ["EDITOR"] } },
    });

    expect(config.egress.deny).toEqual(["a.test", "b.test", "c.test"]);
    expect(config.env.allow).toEqual(expect.arrayContaining(["PAGER", "EDITOR", "TERM"]));
  });
});
