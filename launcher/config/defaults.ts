import type { SandboxConfig } from "./types.ts";

const TERMINAL_VARIABLES = [
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "COLORFGBG",
];

export const DEFAULT_PIDS = 4096;

export const DEFAULT_SERVICE_USER = "1000:1000";

export const DEFAULT_READY_SECONDS = 60;

export const defaultConfig = (): SandboxConfig => ({
  image: {},
  credentials: { rules: [], derive: { enabled: true } },
  egress: { allow: [], deny: [], privateHosts: [] },
  tls: { extraCa: [] },
  mounts: { volumes: [], binds: [] },
  env: { allow: TERMINAL_VARIABLES, set: {} },
  resources: { pids: DEFAULT_PIDS },
  vm: { releaseFileCache: true },
  sessions: { host: true },
  terminal: { clipboard: true },
  writeBack: { enabled: true, exclude: {}, add: {} },
  setup: [],
  services: [],
});
