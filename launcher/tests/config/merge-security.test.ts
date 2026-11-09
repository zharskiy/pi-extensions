import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { getPath, setPath } from "../../config/dotted.ts";
import { mergeLayers } from "../../config/merge.ts";
import type { LayerConfig, LayerName } from "../../config/types.ts";
import { layerKeys, validateLayer } from "../../config/validate.ts";
import { errorMessage, isJsonObject } from "../../shared/index.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

const merge = async (layers: Layers) => mergeLayers({ defaults: await defaultConfig(), layers });

const refusal = async (layers: Layers) => {
  try {
    await merge(layers);

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

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

const UNION_KEYS = ["egress.deny", "env.allow"];

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
  it("makes every key the policy sets final for the org and user layers, except the unions", async () => {
    const results = await Promise.all(
      leafKeys()
        .filter((key) => key !== "org")
        .map(async (key) => {
          const layer = setPath({}, key, getPath(COMPLETE_LAYER, key)) as LayerConfig;

          return {
            key,
            org: await refusal({ policy: layer, org: layer }),
            user: await refusal({ policy: layer, user: layer }),
          };
        }),
    );

    expect(results).toEqual(
      results.map(({ key }) =>
        UNION_KEYS.includes(key)
          ? { key, org: undefined, user: undefined }
          : {
              key,
              org: `org: ${key} is set by the policy config and is final there`,
              user: `user: ${key} is set by the policy config and is final there`,
            },
      ),
    );
  });

  it("makes the org keys final for the user and the project", async () => {
    expect(await refusal({ org: { egress: { allow: ["a.test"] } }, user: { egress: { allow: [] } } })).toBe(
      "user: egress.allow is set by the org config and is final there",
    );
    expect(
      await refusal({
        org: { mounts: { autoOverlays: true } },
        project: { mounts: { autoOverlays: false } },
      }),
    ).toBe("project: mounts.autoOverlays is set by the org config and is final there");
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
