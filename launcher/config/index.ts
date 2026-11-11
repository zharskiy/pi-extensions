export {
  authorityOf,
  fillTemplate,
  isHostName,
  isLoopbackName,
  isNumericName,
  matchesDenyEntry,
  matchesPattern,
  normalizeHost,
  parseEntry,
  parseHostEntry,
  SECRET_MARKER,
  TLS_PORT,
} from "./egress-entry.ts";
export { egressAllowList } from "./egress-presets.ts";
export { loadEffectiveConfig } from "./load.ts";
export { ignoredNotice, isEgressLocked } from "./merge.ts";
export { parentProxyOf } from "./parent-proxy.ts";
export type {
  CredentialRule,
  DeriveConfig,
  EffectiveConfig,
  ExtraCa,
  FileSecret,
  ParentProxy,
  SandboxConfig,
  SecretRef,
} from "./types.ts";
