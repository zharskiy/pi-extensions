import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./paths.ts";

export const PI_AGENT_DIR_VARIABLE = "PI_CODING_AGENT_DIR";

export const PI_SESSION_DIR_VARIABLE = "PI_CODING_AGENT_SESSION_DIR";

const BASH_ENV_VARIABLE = "BASH_ENV";

const JAVA_OPTIONS_VARIABLE = "JAVA_TOOL_OPTIONS";

const PROXY_VARIABLES: readonly string[] = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"];

const LAUNCHER_SET_VARIABLES: readonly string[] = [
  PI_AGENT_DIR_VARIABLE,
  PI_SESSION_DIR_VARIABLE,
  BASH_ENV_VARIABLE,
  JAVA_OPTIONS_VARIABLE,
  ...PROXY_VARIABLES,
  ...PROXY_VARIABLES.map((name) => name.toLowerCase()),
  "NODE_USE_ENV_PROXY",
  "PI_SANDBOX_PROXY_HOST",
  "PI_SANDBOX_PROXY_PORT",
  "PI_SANDBOX_PROXY_TOKEN",
  "NODE_EXTRA_CA_CERTS",
  "PI_SANDBOX_TRUST_HASH",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "PIP_CERT",
  "CARGO_HTTP_CAINFO",
  "GIT_SSL_CAINFO",
  "PI_SANDBOX",
  "PI_SANDBOX_LAUNCH_ID",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "PI_CLIPBOARD_OSC52",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "GITLAB_HOST",
  "GIT_TERMINAL_PROMPT",
  "HOME",
  "PATH",
  "PWD",
];

export const isLauncherSetVariable = (name: string) =>
  LAUNCHER_SET_VARIABLES.includes(name) || PROXY_VARIABLES.includes(name.toUpperCase());

const FILE_URL = /^file:\/\//;

export const hostAgentDir = (home: string, env: NodeJS.ProcessEnv) => {
  const configured = env[PI_AGENT_DIR_VARIABLE];

  if (typeof configured !== "string" || configured === "") {
    return join(home, ".pi", "agent");
  }

  const expanded = expandHome(configured, home);

  return FILE_URL.test(expanded) ? fileURLToPath(expanded) : expanded;
};
