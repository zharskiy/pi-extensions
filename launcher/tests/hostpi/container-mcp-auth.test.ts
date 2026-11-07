import { describe, expect, it } from "vitest";
import { containerMcpAuth, mcpAuthKey } from "../../hostpi/index.ts";
import {
  isPlaceholder,
  readJsonFile,
  stateLayout,
  type VaultServer,
  vaultPlaceholders,
  writeVaultEntry,
} from "../../shared/index.ts";
import { tempDir, vaultDiscovery } from "./fixtures.ts";

const SALT = "e".repeat(64);

const REAL = {
  access: "REAL-ACCESS-TOKEN-501",
  refresh: "REAL-REFRESH-TOKEN-502",
  secret: "REAL-CLIENT-SECRET-503",
};

const vaultServer = (server: string, url: string): VaultServer => ({
  server,
  url,
  ruleId: `derived:mcp:${server}:oauth`,
  ...vaultPlaceholders(SALT, server),
  oauth: { scope: "read" },
  discovery: vaultDiscovery(server, url),
});

const PUBLIC = vaultServer("public-one", "https://mcp.public.example/mcp");

const CONFIDENTIAL = vaultServer("confidential", "https://mcp.confidential.example/mcp");

const FRESH = vaultServer("fresh", "https://mcp.fresh.example/mcp");

const seed = async (stateDir: string) => {
  await writeVaultEntry(stateDir, mcpAuthKey(PUBLIC.server, PUBLIC.url), {
    serverUrl: PUBLIC.url,
    clientInformation: { client_id: "public-client", redirect_uris: ["http://127.0.0.1:33418/callback"] },
    tokens: { access_token: REAL.access, token_type: "Bearer", scope: "read" },
    tokensExpireAt: 123,
  });

  await writeVaultEntry(stateDir, mcpAuthKey(CONFIDENTIAL.server, CONFIDENTIAL.url), {
    serverUrl: CONFIDENTIAL.url,
    clientInformation: {
      client_id: "confidential-client",
      client_secret: REAL.secret,
      token_endpoint_auth_method: "client_secret_basic",
      registration_access_token: "REAL-REGISTRATION-504",
    },
    tokens: { access_token: REAL.access, token_type: "Bearer", refresh_token: REAL.refresh },
  });
};

describe("containerMcpAuth", () => {
  it("gives each vault server placeholders only, a refresh placeholder only with a real refresh token", async () => {
    const stateDir = await tempDir("container-mcp-auth");

    await seed(stateDir);

    const entries = await containerMcpAuth({ stateDir, servers: [PUBLIC, CONFIDENTIAL, FRESH] });

    expect(entries[mcpAuthKey(PUBLIC.server, PUBLIC.url)]).toEqual({
      serverUrl: PUBLIC.url,
      clientInformation: { client_id: "public-client", redirect_uris: ["http://127.0.0.1:33418/callback"] },
      tokens: { access_token: PUBLIC.access, token_type: "Bearer", scope: "read" },
      discovery: PUBLIC.discovery.piState,
    });
    expect(entries[mcpAuthKey(CONFIDENTIAL.server, CONFIDENTIAL.url)]).toEqual({
      serverUrl: CONFIDENTIAL.url,
      clientInformation: {
        client_id: "confidential-client",
        client_secret: CONFIDENTIAL.client,
        token_endpoint_auth_method: "client_secret_basic",
      },
      tokens: {
        access_token: CONFIDENTIAL.access,
        token_type: "Bearer",
        refresh_token: CONFIDENTIAL.refresh,
      },
      discovery: CONFIDENTIAL.discovery.piState,
    });
    expect(isPlaceholder(CONFIDENTIAL.client)).toBe(true);
  });

  it("gives a server without a host sign-in its discovery and no tokens", async () => {
    const stateDir = await tempDir("container-mcp-auth");
    const entries = await containerMcpAuth({ stateDir, servers: [FRESH] });

    expect(entries).toEqual({
      [mcpAuthKey(FRESH.server, FRESH.url)]: { serverUrl: FRESH.url, discovery: FRESH.discovery.piState },
    });
  });

  it("never returns a real token, secret or expiry", async () => {
    const stateDir = await tempDir("container-mcp-auth");

    await seed(stateDir);

    const text = JSON.stringify(await containerMcpAuth({ stateDir, servers: [PUBLIC, CONFIDENTIAL] }));

    expect(text).not.toMatch(/REAL-/);
    expect(text).not.toContain("tokensExpireAt");
  });

  it("records each vault server for the host-side refresh", async () => {
    const stateDir = await tempDir("container-mcp-auth");

    await containerMcpAuth({ stateDir, servers: [PUBLIC] });

    expect(await readJsonFile(stateLayout(stateDir).mcpAuthServer(PUBLIC.server))).toEqual({
      url: PUBLIC.url,
      oauth: { scope: "read" },
    });
  });
});
