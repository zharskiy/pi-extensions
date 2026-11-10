export {
  authorityOf,
  fillTemplate,
  isLoopbackName,
  matchesDenyEntry,
  matchesPattern,
  normalizeHost,
  parseEntry,
  SECRET_MARKER,
  TLS_PORT,
} from "./egress-entry.ts";
export { egressAllowList } from "./egress-presets.ts";
export { loadEffectiveConfig } from "./load.ts";
export { ignoredNotice } from "./merge.ts";
export type {
  CredentialRule,
  DeriveConfig,
  EffectiveConfig,
  ExtraCa,
  FileSecret,
  HostCachePreset,
  ParentProxy,
  SandboxConfig,
  SecretRef,
  WorkspaceRootsConfig,
} from "./types.ts";
