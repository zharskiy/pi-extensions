import type { SandboxConfig } from "../../config/index.ts";

type ConfigOverrides = Omit<Partial<SandboxConfig>, "mounts"> & { mounts?: Partial<SandboxConfig["mounts"]> };

export const sandboxConfig = ({ mounts, ...overrides }: ConfigOverrides = {}): SandboxConfig => ({
  fallback: "host",
  image: {},
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
  mounts: { sharedCaches: [], autoOverlays: true, ...mounts },
  env: { allow: ["TERM", "LANG"] },
  resources: {},
  sessions: { host: true },
  ...overrides,
});
