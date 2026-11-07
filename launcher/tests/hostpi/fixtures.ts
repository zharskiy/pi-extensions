import type { VaultDiscovered } from "../../shared/index.ts";

export { tempDir, writeJson, writeText } from "../support/temp-dir.ts";

export const braced = (name: string) => ["$", "{", name, "}"].join("");

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export const SECRETS = {
  apiKey: "SECRET-AUTH-KEY-7f3a91",
  jwtSignature: "SECRETJWTSIGNATURE88",
  opaqueAccess: "SECRET-OPAQUE-ACCESS-55",
  refresh: "SECRET-REFRESH-TOKEN-41",
  idToken: "SECRET-ID-TOKEN-19",
  modelsKey: "SECRET-MODELS-KEY-23",
  headerLiteral: "SECRET-HEADER-LITERAL-62",
  modelHeader: "SECRET-MODEL-HEADER-77",
  mcpLiteral: "SECRET-MCP-LITERAL-90",
  stdioEnv: "SECRET-STDIO-ENV-31",
  oauthClient: "SECRET-OAUTH-CLIENT-12",
  envValue: "SECRET-ENV-VALUE-06",
};

export const JWT_ACCESS = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({ sub: "user-1", exp: 1 })}.${SECRETS.jwtSignature}`;

export const AGENT_DIR = "/home/user/.pi/agent";

export const hostAuth = () => ({
  keyed: { type: "api_key", key: SECRETS.apiKey },
  jwt: {
    type: "oauth",
    access: JWT_ACCESS,
    refresh: SECRETS.refresh,
    expires: 1700000000000,
    accountId: "account-7",
    idToken: SECRETS.idToken,
  },
  opaque: { type: "oauth", access: SECRETS.opaqueAccess, refresh: SECRETS.refresh, expires: 1 },
  stray: { type: "api_key", key: SECRETS.apiKey },
});

export const hostModels = () => ({
  providers: {
    custom: {
      baseUrl: "https://llm.custom.example/v1",
      apiKey: SECRETS.modelsKey,
      authHeader: true,
      headers: {
        "X-Api-Key": `Bearer ${SECRETS.headerLiteral}`,
        "X-Team": "$TEAM_TOKEN",
        "X-Signed": "!print-signature --now",
        "X-Trace": "plain-value",
      },
      models: [
        {
          id: "model-a",
          baseUrl: "https://model-a.custom.example",
          headers: { Authorization: SECRETS.modelHeader },
        },
        { id: "model-b" },
      ],
    },
    local: { baseUrl: "http://localhost:11434/v1", apiKey: "unused" },
    unknownHost: { apiKey: "$OTHER_KEY" },
  },
});

export const hostMcp = () => ({
  mcpServers: {
    docs: {
      url: "https://mcp.docs.example/mcp",
      headers: { Authorization: `Bearer ${braced("DOCS_TOKEN")}` },
    },
    literal: {
      url: "https://mcp.literal.example/mcp",
      headers: { "X-Auth-Token": SECRETS.mcpLiteral },
    },
    sentryish: {
      url: "https://mcp.oauth.example/mcp",
      oauth: { clientId: "client-1", clientSecret: SECRETS.oauthClient },
    },
    plain: { url: "http://intranet.example/mcp" },
    tools: {
      command: "npx",
      args: ["-y", "tools-mcp"],
      env: {
        API_TOKEN: SECRETS.stdioEnv,
        FROM_ENV: braced("TOOLS_KEY"),
        RUN: "!pass show tools",
        MODE: "fast",
      },
    },
  },
});

export const providerHosts = () => ({
  keyed: { hosts: ["api.keyed.example"] },
  jwt: { hosts: ["api.jwt.example", "alt.jwt.example"] },
  opaque: { hosts: ["api.opaque.example"] },
  envOnly: { hosts: ["api.envonly.example"], envVars: ["ENVONLY_API_KEY"] },
});

export const vaultDiscovery = (server: string, url: string): VaultDiscovered => ({
  ok: true,
  server,
  url,
  fetchedAt: 1_000,
  issuer: "https://auth.vault.example/",
  authorizationEndpoint: "https://auth.vault.example/authorize",
  tokenEndpoint: "https://auth.vault.example/token",
  registrationEndpoint: "https://auth.vault.example/register",
  hosts: ["auth.vault.example"],
  piState: { authorizationServerUrl: "https://auth.vault.example/" },
});
