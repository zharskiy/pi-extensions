import type { SandboxConfig } from "./types.ts";

export const vaultEnabled = (config: Pick<SandboxConfig, "credentials">) =>
  config.credentials.derive.enabled && config.credentials.vault.enabled;
