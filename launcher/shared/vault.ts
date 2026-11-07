import { readFile, rename } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-write.ts";
import { withDirectoryLock } from "./file-lock.ts";
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

export const OAUTH_ROUTES = {
  open: "/oauth/open",
  callback: "/oauth/callback",
  cancel: "/oauth/cancel",
} as const;

export const OAUTH_AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "state",
  "scope",
  "prompt",
  "resource",
] as const;

export interface OAuthOpenRequest {
  url: string;
}

export type OAuthOpenReply =
  | { ok: true; flow: string; port: number; path: string }
  | { ok: false; error: string };

export type OAuthCallbackReply =
  | { status: "ready"; query: string }
  | { status: "pending" }
  | { status: "gone"; error?: string };

export const OAUTH_CALLBACK_STATUS = { ready: 200, pending: 204, gone: 410 } as const;

export type OAuthCancelReply = { ok: true } | { ok: false; error: string };

export const CONTAINER_MCP_AUTH_LOCK = "mcp-auth.json.lock";

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

const isEntry = (value: unknown): value is VaultEntry =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseStore = (text: string | undefined): VaultStore | undefined => {
  try {
    const parsed: unknown = text === undefined || text.trim() === "" ? {} : JSON.parse(text);

    return isEntry(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter((pair): pair is [string, VaultEntry] => isEntry(pair[1])),
        )
      : undefined;
  } catch {
    return undefined;
  }
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

export const writeVaultEntry = (stateDir: string, key: string, entry: VaultEntry | null): Promise<void> => {
  const layout = stateLayout(stateDir);

  return withDirectoryLock(layout.mcpAuthStoreLock, async () => {
    const current = await loadVaultStore(layout.mcpAuthStore, { forWrite: true });
    const { [key]: _replaced, ...others } = current;
    const next = entry === null ? others : { ...others, [key]: entry };

    await writeFileAtomic(layout.mcpAuthStore, `${JSON.stringify(next, null, 2)}\n`, { mode: PRIVATE_MODE });
  });
};
