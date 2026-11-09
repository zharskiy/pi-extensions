import type { SandboxConfig } from "../../config/index.ts";

type ConfigOverrides = Omit<Partial<SandboxConfig>, "mounts"> & { mounts?: Partial<SandboxConfig["mounts"]> };

export const sandboxConfig = ({ mounts, ...overrides }: ConfigOverrides = {}): SandboxConfig => ({
  fallback: "host",
  image: { reference: "ghcr.io/zharskiy/pi-sandbox:0.4.0" },
  credentials: { rules: [], derive: { enabled: true } },
  egress: {
    allow: ["registry.npmjs.org"],
    presets: [],
    deny: [],
    privateHosts: [],
    parentProxy: "env",
    grants: true,
  },
  tls: { extraCa: [] },
  mounts: {
    extraReadOnly: [],
    cacheVolumes: [],
    sharedCaches: [],
    hostCaches: [],
    autoNodeModules: true,
    ...mounts,
  },
  env: { allow: ["TERM", "LANG"] },
  resources: {},
  sessions: { host: true },
  ...overrides,
});
