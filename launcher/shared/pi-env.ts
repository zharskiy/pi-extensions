import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./paths.ts";

export const PI_AGENT_DIR_VARIABLE = "PI_CODING_AGENT_DIR";

export const PI_SESSION_DIR_VARIABLE = "PI_CODING_AGENT_SESSION_DIR";

const BASH_ENV_VARIABLE = "BASH_ENV";

const JAVA_OPTIONS_VARIABLE = "JAVA_TOOL_OPTIONS";

export const LAUNCHER_SET_VARIABLES: readonly string[] = [
  PI_AGENT_DIR_VARIABLE,
  PI_SESSION_DIR_VARIABLE,
  BASH_ENV_VARIABLE,
  JAVA_OPTIONS_VARIABLE,
];

const FILE_URL = /^file:\/\//;

export const hostAgentDir = (home: string, env: NodeJS.ProcessEnv) => {
  const configured = env[PI_AGENT_DIR_VARIABLE];

  if (typeof configured !== "string" || configured === "") {
    return join(home, ".pi", "agent");
  }

  const expanded = expandHome(configured, home);

  return FILE_URL.test(expanded) ? fileURLToPath(expanded) : expanded;
};
