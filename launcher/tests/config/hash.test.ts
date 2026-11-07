import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { configHash } from "../../config/index.ts";

describe("configHash", () => {
  it("ignores key order and changes with any value", async () => {
    const config = await defaultConfig();
    const reordered = Object.fromEntries(Object.entries(config).reverse()) as typeof config;

    expect(configHash(reordered)).toBe(configHash(config));
    expect(configHash(config)).toMatch(/^[0-9a-f]{64}$/);
    expect(configHash({ ...config, resources: { cpus: 3 } })).not.toBe(configHash(config));
  });

  it("changes with every security key, ssh.agent included", async () => {
    const config = await defaultConfig();
    const variants = [
      { ...config, ssh: { agent: true } },
      { ...config, fallback: "refuse" as const },
      { ...config, env: { allow: [...config.env.allow, "EDITOR"] } },
      { ...config, egress: { ...config.egress, allow: ["github.com:22"] } },
      { ...config, mounts: { ...config.mounts, extraReadOnly: ["/opt"] } },
      { ...config, credentials: { kind: "static" as const, rules: [], derive: { enabled: true } } },
      { ...config, credentials: { ...config.credentials, derive: { enabled: false } } },
      { ...config, egress: { ...config.egress, deny: ["evil.test"] } },
      { ...config, tls: { extraCa: [{ file: "/etc/corp-ca.pem" }] } },
      { ...config, image: { ...config.image, digest: `sha256:${"a".repeat(64)}` } },
      { ...config, workspaceRoots: { roots: ["/srv"], outside: "refuse" as const } },
    ];

    variants.forEach((variant) => {
      expect(configHash(variant)).not.toBe(configHash(config));
    });
  });
});
