import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { getPath } from "../../config/dotted.ts";
import { mergeConfig } from "../../config/merge.ts";
import type { UserConfig } from "../../config/types.ts";
import { configKeys, validateConfig } from "../../config/validate.ts";
import { isJsonObject } from "../../shared/index.ts";

const merge = (config: UserConfig) => mergeConfig(defaultConfig(), config);

const COMPLETE_CONFIG: UserConfig = {
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
    deny: ["paste.corp.test"],
    privateHosts: ["*.corp.internal"],
  },
  tls: { extraCa: [{ file: "/etc/corp/ca.pem" }] },
  workspaceRoots: { roots: ["/work"] },
  mounts: { sharedCaches: ["~/.cache/pip"], autoOverlays: false },
  env: { allow: ["EDITOR"] },
  resources: { cpus: 2, memoryGiB: 4 },
  sessions: { host: false },
};

const settableKeys = () => configKeys().filter((key) => key !== "$schema" && !key.includes("[]"));

const leafKeys = () => [
  ...settableKeys().filter((key) => {
    const value = getPath(COMPLETE_CONFIG, key);

    return value !== undefined && !isJsonObject(value) && !key.startsWith("workspaceRoots.");
  }),
  "workspaceRoots",
];

describe("mergeConfig with a config that sets every key", () => {
  it("is a valid config that sets every key", () => {
    expect(validateConfig(COMPLETE_CONFIG)).toEqual(COMPLETE_CONFIG);
    expect(settableKeys().filter((key) => getPath(COMPLETE_CONFIG, key) === undefined)).toEqual([]);
  });

  it("carries every key into the merged config with the config as its source", () => {
    const { config, sources } = merge(COMPLETE_CONFIG);

    leafKeys().forEach((key) => {
      const expected = getPath(COMPLETE_CONFIG, key);

      expect({ key, merged: getPath(config, key), source: sources[key] }).toEqual({
        key,
        merged: key === "env.allow" ? expect.arrayContaining(expected as unknown[]) : expected,
        source: key === "env.allow" ? "default+config" : "config",
      });
    });
  });
});

describe("mergeConfig with part of the keys", () => {
  it("keeps the defaults of the keys the config leaves out, with the default as their source", () => {
    const { config, sources } = merge({ egress: { allow: ["mine.test"] } });

    expect(config.egress).toEqual({ allow: ["mine.test"], deny: [], privateHosts: [] });
    expect(config.sessions.host).toBe(true);
    expect(sources).toMatchObject({ "egress.allow": "config", "egress.deny": "default" });
  });

  it("lets the config set one key of an object and keeps the default of its sibling", () => {
    const { config, sources } = merge({ credentials: { derive: { hosts: ["*.corp.test"] } } });

    expect(config.credentials.derive).toEqual({ enabled: true, hosts: ["*.corp.test"] });
    expect(sources).toMatchObject({
      "credentials.derive.enabled": "default",
      "credentials.derive.hosts": "config",
    });
  });

  it("labels env.allow as default+config because it extends the default", () => {
    expect(merge({ env: { allow: ["EDITOR"] } }).sources["env.allow"]).toBe("default+config");
    expect(merge({}).sources["env.allow"]).toBe("default");
  });

  it("adds the config's env.allow to the default terminal variables without repeating one", () => {
    const { config } = merge({ env: { allow: ["EDITOR", "TERM"] } });

    expect(config.env.allow).toEqual([...defaultConfig().env.allow, "EDITOR"]);
  });

  it("returns the defaults for no config", () => {
    expect(mergeConfig(defaultConfig()).config).toEqual(defaultConfig());
  });
});
