import type { SandboxConfig } from "./types.ts";

const TERMINAL_VARIABLES = [
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "COLORFGBG",
  "LANG",
];

export const defaultConfig = (): SandboxConfig => ({
  image: {},
  credentials: { rules: [], derive: { enabled: true } },
  egress: { allow: [], deny: [], privateHosts: [] },
  tls: { extraCa: [] },
  mounts: { sharedCaches: [], autoOverlays: true },
  env: { allow: TERMINAL_VARIABLES },
  resources: {},
  sessions: { host: true },
});
