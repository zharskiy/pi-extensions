export {
  authorityOf,
  fillTemplate,
  isLoopbackName,
  matchesEntry,
  matchesPattern,
  normalizeHost,
  parseEntry,
  SECRET_MARKER,
  TLS_PORT,
} from "./egress-entry.ts";
export { loadEffectiveConfig } from "./load.ts";
export type {
  CredentialRule,
  DeriveConfig,
  EffectiveConfig,
  ExtraCa,
  ParentProxy,
  SandboxConfig,
  SecretRef,
  WorkspaceRootsConfig,
} from "./types.ts";
