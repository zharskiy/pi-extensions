import type { SandboxConfig } from "../../config/index.ts";

type ConfigOverrides = Omit<Partial<SandboxConfig>, "mounts"> & { mounts?: Partial<SandboxConfig["mounts"]> };

export const sandboxConfig = ({ mounts, ...overrides }: ConfigOverrides = {}): SandboxConfig => ({
  image: {},
  credentials: { rules: [], derive: { enabled: true } },
  egress: { allow: ["registry.npmjs.org"], deny: [], privateHosts: [] },
  tls: { extraCa: [] },
  mounts: { volumes: [], binds: [], ...mounts },
  setup: [],
  services: [],
  env: { allow: ["TERM", "LANG"], set: {} },
  resources: { pids: 4096 },
  vm: { releaseFileCache: true },
  sessions: { host: true },
  terminal: { clipboard: true },
  writeBack: { enabled: true, exclude: {}, add: {} },
  ...overrides,
});
