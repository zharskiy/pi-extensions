import { LauncherError } from "../shared/index.ts";
import type { HostPiFiles, McpOAuthServer } from "./types.ts";

export interface McpLoginInput {
  stateDir: string;
  name: string;
  server: McpOAuthServer;
}

export interface McpSeedInput {
  stateDir: string;
  files: HostPiFiles;
}

export const mcpAuthKey = (name: string, url: string) =>
  `mcp__${name.replace(/-/g, "_")}|${new URL(url).href}`;

export const sanitizeMcpServer = (_definition: unknown): McpOAuthServer | undefined => {
  throw new LauncherError("sanitizeMcpServer is not implemented");
};

export const prepareMcpLogin = async (_input: McpLoginInput): Promise<{ agentDir: string }> => {
  throw new LauncherError("prepareMcpLogin is not implemented");
};

export const seedMcpAuth = async (_input: McpSeedInput): Promise<{ signedIn: string[] }> => {
  throw new LauncherError("seedMcpAuth is not implemented");
};
