import type { SandboxConfig } from "../../config/index.ts";

type ConfigOverrides = Omit<Partial<SandboxConfig>, "mounts"> & { mounts?: Partial<SandboxConfig["mounts"]> };

export const sandboxConfig = ({ mounts, ...overrides }: ConfigOverrides = {}): SandboxConfig => ({
  image: {},
  credentials: { rules: [], derive: { enabled: true } },
  egress: { allow: ["registry.npmjs.org"], deny: [], privateHosts: [] },
  tls: { extraCa: [] },
  mounts: { sharedCaches: [], autoOverlays: true, ...mounts },
  env: { allow: ["TERM", "LANG"] },
  resources: {},
  sessions: { host: true },
  ...overrides,
});
