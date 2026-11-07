import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LauncherError,
  stableHash,
  stateLayout,
  type VaultEntry,
  writeJsonFile,
  writeVaultEntry,
} from "../shared/index.ts";
import { isJsonObject, objectOr } from "./json.ts";
import type { HostPiFiles, JsonObject, McpOAuthServer } from "./types.ts";

export interface McpLoginInput {
  stateDir: string;
  name: string;
  server: McpOAuthServer;
}

export interface McpSeedInput {
  stateDir: string;
  files: HostPiFiles;
}

export interface McpLoginServerInput {
  name: string;
  hostAgentDir: string;
  projectMcpFile: string;
  confirm: () => Promise<boolean>;
}

type OAuthValue = string | number | boolean;

const PRIVATE_MODE = 0o600;

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

const AUTH_FILE = "mcp-auth.json";

const isPlainValue = (value: unknown): value is OAuthValue => {
  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  return typeof value === "string" && !value.startsWith("!") && !value.includes("${");
};

const checkedName = (name: string) => {
  if (!SERVER_NAME.test(name)) {
    throw new LauncherError(`mcp ${name}: a server name may contain only letters, digits, _ and -`);
  }

  return name;
};

const readObject = async (path: string): Promise<JsonObject | undefined> => {
  const text = await readFile(path, "utf8").catch(() => undefined);

  try {
    const value: unknown = text === undefined ? undefined : JSON.parse(text);

    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export const mcpAuthKey = (name: string, url: string) =>
  `mcp__${name.replace(/-/g, "_")}|${new URL(url).href}`;

const isHttpUrl = (url: unknown): url is string => {
  if (typeof url !== "string" || url.includes("${")) {
    return false;
  }

  try {
    return ["https:", "http:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

export const sanitizeMcpServer = (definition: unknown): McpOAuthServer | undefined => {
  if (!isJsonObject(definition) || definition.command !== undefined || !isHttpUrl(definition.url)) {
    return undefined;
  }

  const oauth = Object.entries(objectOr(definition.oauth)).filter(([, value]) => isPlainValue(value));

  return oauth.length === 0
    ? { url: definition.url }
    : { url: definition.url, oauth: Object.fromEntries(oauth) as Record<string, OAuthValue> };
};

const writeOneServer = async (stateDir: string, name: string, server: McpOAuthServer) => {
  const layout = stateLayout(stateDir);

  await writeJsonFile(
    join(layout.mcpAuth, "mcp.json"),
    { mcpServers: { [name]: server } },
    { mode: PRIVATE_MODE },
  );

  return layout.mcpAuth;
};

export const recordServer = async (stateDir: string, name: string, server: McpOAuthServer) => {
  const path = stateLayout(stateDir).mcpAuthServer(name);
  const existing = await readObject(path);

  if (existing === undefined || stableHash(existing) !== stableHash(server)) {
    await writeJsonFile(path, server, { mode: PRIVATE_MODE });
  }
};

export const prepareMcpLogin = async (input: McpLoginInput): Promise<{ agentDir: string }> => {
  const name = checkedName(input.name);
  const server = sanitizeMcpServer(input.server);

  if (server === undefined) {
    throw new LauncherError(`mcp ${name}: not an HTTP server, nothing to sign in to`);
  }

  await recordServer(input.stateDir, name, server);

  return { agentDir: await writeOneServer(input.stateDir, name, server) };
};

export const oneServerDir = async (stateDir: string, name: string) => {
  const server = sanitizeMcpServer(await readObject(stateLayout(stateDir).mcpAuthServer(checkedName(name))));

  if (server === undefined) {
    throw new LauncherError(`mcp ${name}: no recorded server`, `run pi mcp login ${name}`);
  }

  return writeOneServer(stateDir, name, server);
};

const serverIn = async (file: string, name: string) => objectOr((await readObject(file))?.mcpServers)[name];

export const mcpLoginServer = async (input: McpLoginServerInput): Promise<McpOAuthServer> => {
  const name = checkedName(input.name);
  const user = await serverIn(join(input.hostAgentDir, "mcp.json"), name);
  const project = user === undefined ? await serverIn(input.projectMcpFile, name) : undefined;

  if (user === undefined && project === undefined) {
    throw new LauncherError(`mcp ${name}: no such server in the user or project mcp.json`);
  }

  const server = sanitizeMcpServer(user ?? project);

  if (server === undefined) {
    throw new LauncherError(`mcp ${name}: not an HTTP server, nothing to sign in to`);
  }

  if (user === undefined && !(await input.confirm())) {
    throw new LauncherError(`mcp ${name}: the project-only server was not confirmed`);
  }

  return server;
};

const hasToken = (entry: unknown) => {
  const tokens = objectOr(objectOr(entry).tokens);

  return typeof tokens.access_token === "string" || typeof tokens.refresh_token === "string";
};

const hasAuthorization = (definition: unknown) =>
  Object.keys(objectOr(objectOr(definition).headers)).some(
    (header) => header.toLowerCase() === "authorization",
  );

const oauthServers = (files: HostPiFiles) =>
  Object.entries(objectOr(files.mcp?.mcpServers)).flatMap(([name, definition]) => {
    const server =
      SERVER_NAME.test(name) && !hasAuthorization(definition) ? sanitizeMcpServer(definition) : undefined;

    return server === undefined ? [] : [{ name, server, key: mcpAuthKey(name, server.url) }];
  });

export const seedMcpAuth = async (input: McpSeedInput): Promise<{ signedIn: string[] }> => {
  const helperPath = stateLayout(input.stateDir).mcpAuthStore;
  const helperText = await readFile(helperPath, "utf8").catch(() => undefined);
  const helper = await readObject(helperPath);

  if (helperText !== undefined && helper === undefined) {
    return { signedIn: [] };
  }

  const host = objectOr(await readObject(join(input.files.agentDir, AUTH_FILE)));
  const servers = oauthServers(input.files);
  const seeds = servers
    .filter((entry) => !hasToken(helper?.[entry.key]))
    .map((entry) => ({ ...entry, token: host[entry.key] ?? host[new URL(entry.server.url).href] }))
    .filter((entry) => hasToken(entry.token));
  const store = { ...helper, ...Object.fromEntries(seeds.map((entry) => [entry.key, entry.token])) };

  await seeds.reduce(
    (previous, entry) =>
      previous.then(() => writeVaultEntry(input.stateDir, entry.key, entry.token as VaultEntry)),
    Promise.resolve(),
  );

  const signedIn = servers.filter((entry) => hasToken(store[entry.key]));

  await Promise.all(signedIn.map((entry) => recordServer(input.stateDir, entry.name, entry.server)));

  return { signedIn: signedIn.map((entry) => entry.name) };
};
