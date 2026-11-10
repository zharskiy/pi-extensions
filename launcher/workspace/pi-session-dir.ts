import { join, resolve } from "node:path";
import { GUEST_PATHS, hostAgentDir, isWithin, PI_SESSION_DIR_VARIABLE } from "../shared/index.ts";

export type HostSessions = { dir: string } | { off: string; notice: boolean };

interface HostSessionsInput {
  enabled: boolean;
  home: string;
  env: NodeJS.ProcessEnv;
  settings?: Record<string, unknown>;
  repoRoot: string;
}

const isSet = (value: unknown) => typeof value === "string" && value !== "";

export const sessionSlug = (path: string) =>
  `--${resolve(path)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;

export const hostSessionsDir = (agentDir: string, repoRoot: string) =>
  join(resolve(agentDir), "sessions", sessionSlug(repoRoot));

export const hostSessionsChoice = (input: HostSessionsInput): HostSessions => {
  if (!input.enabled) {
    return { off: "sessions.host is off", notice: false };
  }

  if (isSet(input.env[PI_SESSION_DIR_VARIABLE]) || isSet(input.settings?.sessionDir)) {
    return { off: "host pi uses a custom session dir", notice: true };
  }

  const dir = hostSessionsDir(hostAgentDir(input.home, input.env), input.repoRoot);

  return isWithin(dir, GUEST_PATHS.agentDir)
    ? { off: "the host agent directory is the sandbox's own agent path", notice: true }
    : { dir };
};
