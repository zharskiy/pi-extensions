import { readFile, rename } from "node:fs/promises";
import { basename } from "node:path";
import { withDirectoryLock } from "./file-lock.ts";
import { isJsonObject, parseJsonObject, writeJsonFile } from "./json-file.ts";
import { placeholderFor } from "./placeholder.ts";
import { stateLayout } from "./state-layout.ts";

type OAuthValue = string | number | boolean;

interface VaultEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  resource?: string;
  resourceMetadataUrl?: string;
}

interface DiscoveryBase {
  server: string;
  url: string;
  fetchedAt: number;
}

export type VaultDiscovery =
  | (DiscoveryBase & VaultEndpoints & { ok: true; hosts: string[]; piState: Record<string, unknown> })
  | (DiscoveryBase & { ok: false; error: string });

export type VaultDiscovered = Extract<VaultDiscovery, { ok: true }>;

export interface VaultServer {
  server: string;
  url: string;
  ruleId: string;
  access: string;
  refresh: string;
  client: string;
  oauth?: Record<string, OAuthValue>;
  discovery: VaultDiscovered;
}

export interface VaultTokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}

export interface VaultClientInformation {
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
  [field: string]: unknown;
}

export interface VaultEntry {
  serverUrl: string;
  clientInformation?: VaultClientInformation;
  tokens?: VaultTokens;
  tokensExpireAt?: number;
  discovery?: Record<string, unknown>;
  [field: string]: unknown;
}

export type VaultStore = Record<string, VaultEntry>;

export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export const mcpAuthKey = (server: string, url: string) =>
  `mcp__${server.replaceAll("-", "_")}|${new URL(url).href}`;

export const CONTAINER_MCP_AUTH_LOCK = basename(stateLayout("/").mcpAuthStoreLock);

const MIN_EXPIRES_SECONDS = 300;

const MAX_EXPIRES_SECONDS = 3600;

const PRIVATE_MODE = 0o600;

export const vaultPlaceholders = (salt: string, server: string) => ({
  access: placeholderFor(salt, `mcp:${server}:oauth`),
  refresh: placeholderFor(salt, `mcp:${server}:oauth:refresh`),
  client: placeholderFor(salt, `mcp:${server}:oauth:client`),
});

export const syntheticExpiresIn = (remainingSeconds: number) =>
  Math.max(MIN_EXPIRES_SECONDS, Math.min(Math.floor(remainingSeconds), MAX_EXPIRES_SECONDS));

const parseStore = (text: string | undefined): VaultStore | undefined => {
  const parsed = text === undefined || text.trim() === "" ? {} : parseJsonObject(text);

  return parsed === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(parsed).filter((pair): pair is [string, VaultEntry] => isJsonObject(pair[1])),
      );
};

const moveAside = async (path: string) => {
  const now = new Date();
  const aside = `${path}.corrupt-${now.getTime()}`;
  const moved = await rename(path, aside).then(
    () => true,
    () => false,
  );

  if (moved) {
    process.stderr.write(
      `${now.toISOString()} pi-sandbox: ${path} did not parse; moved it to ${aside} and started an empty store\n`,
    );
  }
};

export const loadVaultStore = async (path: string, options: { forWrite: boolean }): Promise<VaultStore> => {
  const store = parseStore(await readFile(path, "utf8").catch(() => undefined));

  if (store !== undefined) {
    return store;
  }

  if (options.forWrite) {
    await moveAside(path);
  }

  return {};
};

export const readVaultStore = (stateDir: string): Promise<VaultStore> => {
  const layout = stateLayout(stateDir);

  return withDirectoryLock(layout.mcpAuthStoreLock, () =>
    loadVaultStore(layout.mcpAuthStore, { forWrite: false }),
  );
};

export const updateVaultStore = (
  stateDir: string,
  update: (store: VaultStore) => VaultStore | undefined,
): Promise<void> => {
  const layout = stateLayout(stateDir);

  return withDirectoryLock(layout.mcpAuthStoreLock, async () => {
    const next = update(await loadVaultStore(layout.mcpAuthStore, { forWrite: true }));

    if (next !== undefined) {
      await writeJsonFile(layout.mcpAuthStore, next, { mode: PRIVATE_MODE });
    }
  });
};

export const writeVaultEntry = (stateDir: string, key: string, entry: VaultEntry | null): Promise<void> =>
  updateVaultStore(stateDir, (current) => {
    const { [key]: _replaced, ...others } = current;

    return entry === null ? others : { ...others, [key]: entry };
  });
