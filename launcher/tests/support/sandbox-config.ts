import type { SandboxConfig } from "../../config/index.ts";

export const sandboxConfig = (overrides: Partial<SandboxConfig> = {}): SandboxConfig => ({
  backend: "auto",
  fallback: "host",
  image: { reference: "ghcr.io/zharskiy/pi-sandbox:0.4.0" },
  credentials: { kind: "host-pi-auth" },
  egress: { allow: ["registry.npmjs.org"], mcpHosts: [], denyPrivateAddresses: true },
  mounts: { extraReadOnly: [], cacheVolumes: [] },
  env: { allow: ["TERM", "LANG"] },
  ssh: { agent: false },
  resources: {},
  ...overrides,
});
