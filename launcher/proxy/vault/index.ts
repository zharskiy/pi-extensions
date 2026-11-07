import {
  type CommandRunner,
  errorMessage,
  type OAuthOpenRequest,
  type VaultDiscovered,
  type VaultServer,
} from "../../shared/index.ts";
import { matchesEntry } from "../policy.ts";
import type { SecretResolver } from "../secrets/index.ts";
import { type OpenBrowser, openInBrowser } from "./browser.ts";
import { createFlows, type VaultReply } from "./callback.ts";
import { createDiscovery } from "./discovery.ts";
import { checkAuthorizeUrl, createOpenLimiter, type OpenCandidate } from "./open.ts";
import { type BufferQuery, createTokenHook, type VaultTokenHook } from "./token.ts";

export type { VaultReply } from "./callback.ts";
export type { TokenPlan, TokenResponse, VaultTokenHook } from "./token.ts";

export interface VaultOptions {
  stateDir: string;
  servers: (repoHash?: string) => Promise<VaultServer[]>;
  resolver: SecretResolver;
  runner: CommandRunner;
  discoverCommand?: string[];
  openBrowser?: OpenBrowser;
  now?: () => number;
  flowTtlMs?: number;
  pollMs?: number;
}

export interface VaultHook extends VaultTokenHook {
  isVaultHost(host: string, port: number, repoHash?: string): Promise<boolean>;
  open(repoHash: string, body: unknown): Promise<VaultReply>;
  callback(repoHash: string, flow: string, signal?: AbortSignal): Promise<VaultReply>;
  cancel(repoHash: string, flow: string): Promise<VaultReply>;
  close(): Promise<void>;
}

const FLOW_TTL_MS = 10 * 60_000;

const POLL_MS = 25_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const failure = (status: number, error: string): VaultReply => ({ status, body: { ok: false, error } });

export const createVault = (options: VaultOptions): VaultHook => {
  const now = options.now ?? Date.now;
  const flows = createFlows({
    now,
    ttlMs: options.flowTtlMs ?? FLOW_TTL_MS,
    pollMs: options.pollMs ?? POLL_MS,
  });
  const discover = createDiscovery({
    stateDir: options.stateDir,
    runner: options.runner,
    command: options.discoverCommand,
    now,
  });
  const allowOpen = createOpenLimiter(now);
  const browser = options.openBrowser ?? openInBrowser();
  const tokens = createTokenHook({
    stateDir: options.stateDir,
    servers: options.servers,
    resolver: options.resolver,
    flows,
    now,
  });

  const isVaultHost = async (host: string, port: number, repoHash?: string) =>
    (await options.servers(repoHash)).some((server) =>
      server.discovery.hosts.some((entry) => matchesEntry(entry, host, port)),
    );

  const candidates = async (repoHash: string) => {
    const found = await Promise.all(
      (await options.servers(repoHash)).map(async (server) => ({
        server,
        discovery: await discover(server),
      })),
    );

    return found.filter((entry): entry is OpenCandidate => entry.discovery.ok);
  };

  const open = async (repoHash: string, body: unknown): Promise<VaultReply> => {
    const request: Partial<OAuthOpenRequest> = isObject(body) ? body : {};
    const check = checkAuthorizeUrl(request.url, await candidates(repoHash));

    if (!check.ok) {
      return failure(check.status, check.error);
    }

    if (!allowOpen(repoHash)) {
      return failure(429, "pi-sandbox: too many sign-in attempts; wait a few minutes");
    }

    const authorize = check.request;
    const discovery: VaultDiscovered = authorize.candidate.discovery;
    const started = await flows.start({
      repoHash,
      server: authorize.candidate.server.server,
      state: authorize.state,
      redirectUri: authorize.redirectUri,
      path: authorize.path,
      port: authorize.port,
      ...(authorize.scope === undefined ? {} : { scope: authorize.scope }),
      tokenEndpoint: discovery.tokenEndpoint,
    });

    if (!started.ok) {
      return failure(started.status, started.error);
    }

    const problem = await browser(authorize.url).then(
      () => undefined,
      (error: unknown) => errorMessage(error),
    );

    if (problem !== undefined) {
      await flows.finish(started.flow.id);

      return failure(502, `pi-sandbox: cannot open the browser on the host: ${problem}`);
    }

    return {
      status: 200,
      body: { ok: true, flow: started.flow.id, port: authorize.port, path: authorize.path },
    };
  };

  const buffers = async (query: BufferQuery) =>
    (await isVaultHost(query.host, query.port, query.repoHash)) && (await tokens.buffers(query));

  return {
    isVaultHost,
    open,
    callback: flows.poll,
    cancel: flows.cancel,
    buffers,
    plan: tokens.plan,
    close: flows.close,
  };
};
