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
  fallback: "host",
  image: {},
  credentials: { rules: [], derive: { enabled: true } },
  egress: {
    allow: [],
    presets: ["npm", "pypi", "github"],
    deny: [],
    privateHosts: [],
    parentProxy: "env",
    grants: true,
  },
  tls: { extraCa: [] },
  mounts: { sharedCaches: [], autoOverlays: true },
  env: { allow: TERMINAL_VARIABLES },
  resources: {},
  sessions: { host: true },
});
