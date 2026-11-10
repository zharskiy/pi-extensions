import {
  isFreshMcpToken,
  isJsonObject,
  MCP_SERVER_NAME,
  type McpAuthEntry,
  readMcpAuthEntry,
} from "../shared/index.ts";
import { endpointOf, hasQueryCredential, hasUrlPassword, withoutUserinfo } from "./endpoints.ts";
import { carriesCredential } from "./headers.ts";
import { objectOr } from "./json.ts";
import type { HostPiFiles, McpOAuthServer } from "./types.ts";

export interface McpSignIn extends McpOAuthServer {
  entry?: McpAuthEntry;
}

const hasCredentialHeader = (headers: unknown) =>
  isJsonObject(headers) && Object.entries(headers).some(([name, value]) => carriesCredential(name, value));

export const oauthTarget = (name: string, definition: unknown) => {
  if (!MCP_SERVER_NAME.test(name) || !isJsonObject(definition) || typeof definition.url !== "string") {
    return undefined;
  }

  const { url, headers } = definition;
  const reachable = "endpoint" in endpointOf(withoutUserinfo(url));

  return reachable && !hasQueryCredential(url) && !hasUrlPassword(url) && !hasCredentialHeader(headers)
    ? withoutUserinfo(url)
    : undefined;
};

const mcpOAuthServers = (files: HostPiFiles): McpOAuthServer[] =>
  Object.entries(objectOr(files.mcp?.mcpServers)).flatMap(([name, definition]) => {
    const url = oauthTarget(name, definition);

    return url === undefined ? [] : [{ name, url }];
  });

export const mcpSignIns = (files: HostPiFiles): Promise<McpSignIn[]> =>
  Promise.all(
    mcpOAuthServers(files).map(async (server) => {
      const entry = await readMcpAuthEntry(files.agentDir, server.name, server.url);

      return entry === undefined ? server : { ...server, entry };
    }),
  );

export const mcpSignInsNeeded = async (files: HostPiFiles, now: number): Promise<McpOAuthServer[]> =>
  (await mcpSignIns(files))
    .filter((server) => server.entry?.refresh === undefined && !isFreshMcpToken(server.entry, now))
    .map(({ name, url }) => ({ name, url }));
