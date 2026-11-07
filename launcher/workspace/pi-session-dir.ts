import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expandHome,
  GUEST_PATHS,
  isWithin,
  PI_AGENT_DIR_VARIABLE,
  PI_SESSION_DIR_VARIABLE,
} from "../shared/index.ts";

export type HostSessions = { dir: string } | { off: string; notice: boolean };

interface HostSessionsInput {
  enabled: boolean;
  home: string;
  env: NodeJS.ProcessEnv;
  settings?: Record<string, unknown>;
  repoRoot: string;
}

const SWITCH_VARIABLE = "PI_SANDBOX_SESSIONS_HOST";

const SWITCH_OFF = "off";

const FILE_URL = /^file:\/\//;

const isSet = (value: unknown) => typeof value === "string" && value !== "";

const normalizedPath = (path: string, home: string) => {
  const expanded = expandHome(path, home);

  return FILE_URL.test(expanded) ? fileURLToPath(expanded) : expanded;
};

export const hostAgentDir = (home: string, env: NodeJS.ProcessEnv) => {
  const configured = env[PI_AGENT_DIR_VARIABLE];

  return isSet(configured) ? normalizedPath(configured as string, home) : join(home, ".pi", "agent");
};

export const sessionSlug = (path: string) =>
  `--${resolve(path)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;

export const hostSessionsDir = (agentDir: string, repoRoot: string) =>
  join(resolve(agentDir), "sessions", sessionSlug(repoRoot));

export const sessionsSwitchNotice = (env: NodeJS.ProcessEnv) => {
  const value = env[SWITCH_VARIABLE];

  return value === undefined || value === SWITCH_OFF
    ? undefined
    : `sessions: ${SWITCH_VARIABLE}=${value} is not "${SWITCH_OFF}" and is ignored`;
};

export const hostSessionsChoice = (input: HostSessionsInput): HostSessions => {
  if (!input.enabled) {
    return { off: "sessions.host is off", notice: false };
  }

  if (input.env[SWITCH_VARIABLE] === SWITCH_OFF) {
    return { off: `${SWITCH_VARIABLE} is off`, notice: false };
  }

  if (isSet(input.env[PI_SESSION_DIR_VARIABLE]) || isSet(input.settings?.sessionDir)) {
    return { off: "host pi uses a custom session dir", notice: true };
  }

  const dir = hostSessionsDir(hostAgentDir(input.home, input.env), input.repoRoot);

  return isWithin(dir, GUEST_PATHS.agentDir)
    ? { off: "the host agent directory is the sandbox's own agent path", notice: true }
    : { dir };
};
