import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  errorMessage,
  launcherRoot,
  readVaultStore,
  stateLayout,
  type VaultClientInformation,
  type VaultDiscovery,
  type VaultEntry,
  type VaultServer,
  writeJsonFile,
} from "../shared/index.ts";
import { endpointOf } from "./endpoints.ts";
import { isJsonObject, objectOr } from "./json.ts";
import { mcpAuthKey, recordServer, sanitizeMcpServer } from "./mcp-auth.ts";
import type {
  BundledPi,
  ContainerMcpAuthEntries,
  ContainerMcpAuthInput,
  JsonObject,
  McpOAuthServer,
  VaultDiscoveryInput,
  VaultDiscoveryResult,
} from "./types.ts";
import { hasUrlPassword } from "./userinfo.ts";

const SCRIPT = "mcp-discover.mjs";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;

const FAILURE_TTL_MS = 60 * 1000;

const PRIVATE_MODE = 0o600;

const BEARER = "Bearer";

const CLIENT_FIELDS = ["client_id", "redirect_uris", "token_endpoint_auth_method"] as const;

const hasAuthorization = (headers: unknown) =>
  Object.keys(objectOr(headers)).some((header) => header.toLowerCase() === "authorization");

const withoutUserinfo = (url: string) => {
  const parsed = new URL(url);

  parsed.username = "";

  return parsed.href;
};

export const vaultCandidate = (name: string, definition: unknown): McpOAuthServer | undefined => {
  if (!SERVER_NAME.test(name) || !isJsonObject(definition) || typeof definition.url !== "string") {
    return undefined;
  }

  const excluded =
    hasAuthorization(definition.headers) ||
    hasUrlPassword(definition.url) ||
    definition.auth !== undefined ||
    objectOr(definition.oauth).clientSecret !== undefined;

  if (excluded || !("endpoint" in endpointOf(definition.url))) {
    return undefined;
  }

  return sanitizeMcpServer({ ...definition, url: withoutUserinfo(definition.url) });
};

export const vaultCandidates = (mcp: JsonObject): Record<string, McpOAuthServer> =>
  Object.fromEntries(
    Object.entries(objectOr(mcp.mcpServers)).flatMap(([name, definition]) => {
      const server = vaultCandidate(name, definition);

      return server === undefined ? [] : [[name, server]];
    }),
  );

export const mcpDiscoverCommand = (pi: BundledPi): string[] => [
  process.execPath,
  join(launcherRoot(), "hostpi", SCRIPT),
  pi.packageDir,
];

const isString = (value: unknown): value is string => typeof value === "string";

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

const optionalString = (value: JsonObject, field: string) =>
  isString(value[field]) ? { [field]: value[field] } : {};

const discoveryFrom = (
  value: unknown,
  base: { server: string; url: string; fetchedAt: number },
): VaultDiscovery | undefined => {
  if (!isJsonObject(value)) {
    return undefined;
  }

  if (value.ok === false && isString(value.error)) {
    return { ...base, ok: false, error: value.error };
  }

  const valid =
    value.ok === true &&
    isString(value.issuer) &&
    isString(value.authorizationEndpoint) &&
    isString(value.tokenEndpoint) &&
    isStringList(value.hosts) &&
    isJsonObject(value.piState);

  return valid
    ? {
        ...base,
        ok: true,
        issuer: String(value.issuer),
        authorizationEndpoint: String(value.authorizationEndpoint),
        tokenEndpoint: String(value.tokenEndpoint),
        ...optionalString(value, "registrationEndpoint"),
        ...optionalString(value, "resource"),
        ...optionalString(value, "resourceMetadataUrl"),
        hosts: value.hosts as string[],
        piState: value.piState as Record<string, unknown>,
      }
    : undefined;
};

const parseJson = (text: string | undefined): unknown => {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isFresh = (discovery: VaultDiscovery, now: number) => {
  const age = now - discovery.fetchedAt;

  return age >= 0 && age < (discovery.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS);
};

const cachedDiscovery = async (path: string, name: string, server: McpOAuthServer, now: number) => {
  const value = parseJson(await readFile(path, "utf8").catch(() => undefined));
  const record = objectOr(value);

  if (record.server !== name || record.url !== server.url || typeof record.fetchedAt !== "number") {
    return undefined;
  }

  const discovery = discoveryFrom(value, { server: name, url: server.url, fetchedAt: record.fetchedAt });

  return discovery !== undefined && isFresh(discovery, now) ? discovery : undefined;
};

const discoveryRequest = (server: McpOAuthServer) =>
  JSON.stringify({
    url: server.url,
    ...(isString(server.oauth?.authServerMetadataUrl)
      ? { authServerMetadataUrl: server.oauth.authServerMetadataUrl }
      : {}),
  });

const runDiscovery = async (
  input: VaultDiscoveryInput,
  name: string,
  server: McpOAuthServer,
): Promise<VaultDiscovery> => {
  const [file = process.execPath, ...args] = mcpDiscoverCommand(input.pi);
  const result = await input.runner
    .run(file, args, { input: discoveryRequest(server) })
    .catch((error: unknown) => ({ code: 1, stdout: "", stderr: errorMessage(error) }));
  const base = { server: name, url: server.url, fetchedAt: input.now() };
  const parsed = result.code === 0 ? discoveryFrom(parseJson(result.stdout), base) : undefined;

  if (parsed !== undefined) {
    return parsed;
  }

  const error =
    result.code === 0 ? "unreadable discovery output" : result.stderr.trim() || `exit ${result.code}`;

  return { ...base, ok: false, error };
};

const discoverOne = async (input: VaultDiscoveryInput, name: string, server: McpOAuthServer) => {
  const path = stateLayout(input.stateDir).mcpAuthDiscovery(name);
  const cached = await cachedDiscovery(path, name, server, input.now());

  if (cached !== undefined) {
    return cached;
  }

  const discovery = await runDiscovery(input, name, server);

  await writeJsonFile(path, discovery, { mode: PRIVATE_MODE });

  return discovery;
};

const failureNotice = (discovery: VaultDiscovery) =>
  discovery.ok
    ? []
    : [
        `mcp ${discovery.server}: sign-in discovery failed (${discovery.error}); this launch uses the host sign-in instead`,
      ];

export const discoverVaultServers = async (input: VaultDiscoveryInput): Promise<VaultDiscoveryResult> => {
  const found = await Promise.all(
    Object.entries(input.candidates).map(([name, server]) => discoverOne(input, name, server)),
  );

  return {
    discovery: Object.fromEntries(found.map((discovery) => [discovery.server, discovery])),
    notices: found.flatMap(failureNotice),
  };
};

const clientInformationFor = (client: VaultClientInformation | undefined, placeholder: string) => {
  if (client === undefined || !isString(client.client_id)) {
    return {};
  }

  const fields = Object.fromEntries(
    CLIENT_FIELDS.flatMap((field) => (field in client ? [[field, client[field]]] : [])),
  );
  const secret =
    isString(client.client_secret) && client.client_secret !== "" ? { client_secret: placeholder } : {};

  return { clientInformation: { ...fields, ...secret } };
};

const tokensFor = (entry: VaultEntry | undefined, server: VaultServer) => {
  const tokens = entry?.tokens;

  if (tokens === undefined || (!isString(tokens.access_token) && !isString(tokens.refresh_token))) {
    return {};
  }

  return {
    tokens: {
      access_token: server.access,
      token_type: BEARER,
      ...(isString(tokens.refresh_token) && tokens.refresh_token !== ""
        ? { refresh_token: server.refresh }
        : {}),
      ...(isString(tokens.scope) ? { scope: tokens.scope } : {}),
    },
  };
};

const containerEntry = (entry: VaultEntry | undefined, server: VaultServer): JsonObject => ({
  serverUrl: new URL(server.url).href,
  ...clientInformationFor(entry?.clientInformation, server.client),
  ...tokensFor(entry, server),
  discovery: server.discovery.piState,
});

export const containerMcpAuth = async (input: ContainerMcpAuthInput): Promise<ContainerMcpAuthEntries> => {
  await Promise.all(
    input.servers.map((server) =>
      recordServer(input.stateDir, server.server, {
        url: server.url,
        ...(server.oauth === undefined ? {} : { oauth: server.oauth }),
      }),
    ),
  );

  const store = await readVaultStore(input.stateDir);

  return Object.fromEntries(
    input.servers.map((server) => {
      const key = mcpAuthKey(server.server, server.url);

      return [key, containerEntry(store[key], server)];
    }),
  );
};
