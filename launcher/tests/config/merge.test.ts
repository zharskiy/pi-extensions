import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { getPath } from "../../config/index.ts";
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
    dockerfile: "/etc/pinata/layer.Dockerfile",
  },
  credentials: {
    rules: [
      {
        id: "llm",
        host: "llm.corp.test",
        placeholder: "pinata-llm",
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
  workspaceRoot: "/work",
  mounts: {
    volumes: ["~/.cache/pip", { target: "/opt/data", name: "data" }],
    binds: [{ source: "/etc/corp", target: "/etc/corp" }],
  },
  setup: [["npm", "ci"]],
  services: [{ name: "db", command: ["db"], memoryGiB: 1 }],
  env: { allow: ["EDITOR"], set: { CI: "1", EDITOR: "vi" } },
  resources: { cpus: 2, memoryGiB: 4, pids: 8192, openFiles: 65536, shmMiB: 1024 },
  vm: { cpus: 4, memoryGiB: 8, diskGiB: 80, releaseFileCache: false },
  sessions: { host: false },
  terminal: { clipboard: false },
  writeBack: {
    enabled: false,
    exclude: { "settings.json": ["theme"] },
    add: { "pi-footer.json": { layout: { type: "json" } } },
  },
};

const settableKeys = () => configKeys().filter((key) => key !== "$schema" && !key.includes("[]"));

const leafKeys = () => [
  ...settableKeys().filter((key) => {
    const value = getPath(COMPLETE_CONFIG, key);

    return value !== undefined && !isJsonObject(value);
  }),
  "env.set",
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

  it("takes env.set from the config key by key, over defaults that set none", () => {
    const { config, sources } = merge({ env: { set: { CI: "1", LANG: "C.UTF-8" } } });

    expect(defaultConfig().env.set).toEqual({});
    expect(config.env).toEqual({ allow: defaultConfig().env.allow, set: { CI: "1", LANG: "C.UTF-8" } });
    expect(sources).toMatchObject({ "env.set": "config", "env.allow": "default" });
    expect(merge({}).sources["env.set"]).toBe("default");
  });

  it("keeps the default pids limit next to a configured open files limit and sends no default for the others", () => {
    const { config, sources } = merge({ resources: { openFiles: 65536 } });

    expect(config.resources).toEqual({ pids: 4096, openFiles: 65536 });
    expect(sources).toMatchObject({ "resources.pids": "default", "resources.openFiles": "config" });
    expect(sources["resources.shmMiB"]).toBeUndefined();
  });

  it("returns the defaults for no config", () => {
    expect(mergeConfig(defaultConfig()).config).toEqual(defaultConfig());
  });
});
