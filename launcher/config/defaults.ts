import { join } from "node:path";
import { LauncherError, launcherRoot, readJsonFile } from "../shared/index.ts";
import type { SandboxConfig } from "./types.ts";

const PACKAGE_NAME = "pi-extensions-mz";

const IMAGE_REPOSITORY = "ghcr.io/zharskiy/pi-sandbox";

const DEFAULT_EGRESS = ["registry.npmjs.org", "github.com", "pypi.org", "files.pythonhosted.org"];

const DEFAULT_GRANT_HOURS = 168;

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

const packageVersion = async () => {
  const file = join(launcherRoot(), "..", "package.json");
  const manifest = await readJsonFile<{ name?: unknown; version?: unknown }>(file);

  if (manifest?.name !== PACKAGE_NAME || typeof manifest.version !== "string") {
    throw new LauncherError(`${file}: not the ${PACKAGE_NAME} package manifest`, "reinstall the launcher");
  }

  return manifest.version;
};

export const defaultConfig = async (): Promise<SandboxConfig> => ({
  backend: "auto",
  fallback: "host",
  image: { reference: `${IMAGE_REPOSITORY}:${await packageVersion()}` },
  credentials: { kind: "host-pi-auth", rules: [], derive: { enabled: true }, vault: { enabled: true } },
  egress: {
    allow: DEFAULT_EGRESS,
    mcpHosts: [],
    denyPrivateAddresses: true,
    deny: [],
    privateHosts: [],
    parentProxy: "env",
    grants: { enabled: true, maxHours: DEFAULT_GRANT_HOURS, permanent: true },
  },
  tls: { extraCa: [] },
  mounts: { extraReadOnly: [], cacheVolumes: [], sharedCaches: [], autoNodeModules: true },
  env: { allow: TERMINAL_VARIABLES },
  ssh: { agent: false },
  resources: {},
  sessions: { host: true },
});
