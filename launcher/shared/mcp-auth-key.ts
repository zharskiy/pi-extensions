import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./file-lock.ts";
import { isJsonObject, parseJsonObject, readJsonObject, writeJsonFile } from "./json-file.ts";
import { stateLayout } from "./state-layout.ts";

export interface McpAuthEntry {
  access?: string;
  refresh?: string;
  expiresAt?: number;
}

export interface McpLoginState {
  lastStart?: number;
  failedAt?: number;
  rejectedStart?: number;
}

export type McpLogins = Record<string, McpLoginState>;

export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export const MCP_TOKEN_SKEW_MS = 30_000;

const HOST_STORE = "mcp-auth.json";

const PRIVATE_MODE = 0o600;

export const mcpAuthKey = (server: string, url: string) =>
  `mcp__${server.replaceAll("-", "_")}|${new URL(url).href}`;

const textOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

const entryOf = (value: unknown): McpAuthEntry | undefined => {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const tokens = isJsonObject(value.tokens) ? value.tokens : {};
  const access = textOf(tokens.access_token);
  const refresh = textOf(tokens.refresh_token);
  const expiresAt = typeof value.tokensExpireAt === "number" ? value.tokensExpireAt : undefined;

  return {
    ...(access === undefined ? {} : { access }),
    ...(refresh === undefined ? {} : { refresh }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
};

export const readMcpAuthEntry = async (
  hostAgentDir: string,
  server: string,
  url: string,
): Promise<McpAuthEntry | undefined> => {
  const text = await readFile(join(hostAgentDir, HOST_STORE), "utf8").catch(() => undefined);
  const store = text === undefined ? undefined : parseJsonObject(text);

  return store === undefined
    ? undefined
    : entryOf(store[mcpAuthKey(server, url)] ?? store[new URL(url).href]);
};

export const isFreshMcpToken = (entry: McpAuthEntry | undefined, now: number) =>
  entry?.access !== undefined && (entry.expiresAt === undefined || entry.expiresAt - MCP_TOKEN_SKEW_MS > now);

const LOGIN_TIMEOUT_SECONDS = 300;

export const mcpLoginCommand = (piCommand: string[], server: string) => [
  ...piCommand,
  "mcp",
  "login",
  server,
  "--timeout",
  String(LOGIN_TIMEOUT_SECONDS),
];

const makeMcpLoginDir = async (stateDir: string) => {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  return mkdtemp(stateLayout(stateDir).mcpLoginDirPrefix);
};

export const withMcpLoginDir = async <T>(stateDir: string, use: (cwd: string) => Promise<T>): Promise<T> => {
  const cwd = await makeMcpLoginDir(stateDir);

  try {
    return await use(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

const stateOf = (value: unknown): McpLoginState => (isJsonObject(value) ? (value as McpLoginState) : {});

export const readMcpLogins = async (stateDir: string): Promise<McpLogins> =>
  Object.fromEntries(
    Object.entries((await readJsonObject(stateLayout(stateDir).mcpLogin)) ?? {}).map(([key, value]) => [
      key,
      stateOf(value),
    ]),
  );

export const updateMcpLogin = (
  stateDir: string,
  key: string,
  update: (current: McpLoginState) => McpLoginState,
) =>
  withFileLock(stateLayout(stateDir).mcpLoginFileLock, async () => {
    const logins = await readMcpLogins(stateDir);
    const next = update(logins[key] ?? {});

    await writeJsonFile(stateLayout(stateDir).mcpLogin, { ...logins, [key]: next }, { mode: PRIVATE_MODE });

    return next;
  });
