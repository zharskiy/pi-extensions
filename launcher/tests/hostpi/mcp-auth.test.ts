import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mcpSignInsNeeded } from "../../hostpi/index.ts";
import { mcpAuthKey } from "../../shared/index.ts";
import { tempDir, writeJson } from "./fixtures.ts";

const NOW = 1_700_000_000_000;

const SERVERS = {
  missing: { url: "https://missing.example/mcp" },
  expired: { url: "https://expired.example/mcp" },
  refreshable: { url: "https://refreshable.example/mcp" },
  fresh: { url: "https://fresh.example/mcp" },
  headed: { url: "https://headed.example/mcp", headers: { Authorization: "Bearer x" } },
  local: { url: "http://intranet.example/mcp" },
  tool: { command: "npx" },
};

const filesWith = async (store: Record<string, unknown>) => {
  const agentDir = await tempDir("mcp-auth");

  await writeJson(join(agentDir, "mcp-auth.json"), store);

  return { agentDir, mcp: { mcpServers: SERVERS } };
};

describe("mcpSignInsNeeded", () => {
  it("lists the OAuth servers with neither a fresh access token nor a refresh token", async () => {
    const files = await filesWith({
      [mcpAuthKey("expired", SERVERS.expired.url)]: {
        tokens: { access_token: "a" },
        tokensExpireAt: NOW - 1,
      },
      [mcpAuthKey("refreshable", SERVERS.refreshable.url)]: {
        tokens: { access_token: "a", refresh_token: "r" },
        tokensExpireAt: NOW - 1,
      },
      [mcpAuthKey("fresh", SERVERS.fresh.url)]: {
        tokens: { access_token: "a" },
        tokensExpireAt: NOW + 3_600_000,
      },
    });

    expect(await mcpSignInsNeeded(files, NOW)).toEqual([
      { name: "missing", url: "https://missing.example/mcp" },
      { name: "expired", url: "https://expired.example/mcp" },
    ]);
  });

  it("treats an unreadable store as no sign-in at all", async () => {
    const files = await filesWith({});

    await writeJson(join(files.agentDir, "mcp-auth.json"), "not an object");

    expect((await mcpSignInsNeeded(files, NOW)).map((server) => server.name)).toEqual([
      "missing",
      "expired",
      "refreshable",
      "fresh",
    ]);
  });
});
