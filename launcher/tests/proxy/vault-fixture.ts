import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createServer as createNetServer } from "node:net";
import { createSecureContext } from "node:tls";
import type { CredentialRule } from "../../config/index.ts";
import { writeProxyDynamic } from "../../proxy/dynamic.ts";
import { createProxyRuntime } from "../../proxy/runtime.ts";
import type { SecretResolver } from "../../proxy/secrets/index.ts";
import type { LauncherCa } from "../../proxy/tls-ca.ts";
import { createVault, type VaultHook } from "../../proxy/vault/index.ts";
import { type VaultServer, vaultPlaceholders } from "../../shared/index.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { listen, POLICY_HASH, portOf, startTestProxy, type TestProxy } from "./harness.ts";
import { readBody, requestThrough } from "./proxy-client.ts";

const SALT = "5".repeat(64);

export const REPO = "1".repeat(64);

export const OTHER_REPO = "2".repeat(64);

export const MCP_URL = "https://mcp.test/mcp";

export const PLACEHOLDERS = vaultPlaceholders(SALT, "docs");

export const RULE_ID = "derived:mcp:docs:oauth";

export const vaultServer = (overrides: Partial<VaultServer> = {}): VaultServer => ({
  server: "docs",
  url: MCP_URL,
  ruleId: RULE_ID,
  ...PLACEHOLDERS,
  discovery: {
    ok: true,
    server: "docs",
    url: MCP_URL,
    issuer: "https://auth.test",
    authorizationEndpoint: "https://auth.test/authorize",
    tokenEndpoint: "https://auth.test/token",
    registrationEndpoint: "https://auth.test/register",
    resource: MCP_URL,
    hosts: ["auth.test", "mcp.test"],
    piState: {},
    fetchedAt: 0,
  },
  ...overrides,
});

const accessRule: CredentialRule = {
  id: RULE_ID,
  host: "mcp.test",
  placeholder: PLACEHOLDERS.access,
  secret: { mcpOAuth: { server: "docs", url: MCP_URL } },
};

interface UpstreamCall {
  host: string;
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

type UpstreamHandler = (call: UpstreamCall, response: ServerResponse) => void;

export const sendJson = (response: ServerResponse, status: number, body: object) => {
  response.writeHead(status, { "content-type": "application/json" });

  response.end(JSON.stringify(body));
};

const TOKEN_RESPONSE = {
  access_token: "real-access-token",
  token_type: "Bearer",
  expires_in: 7200,
  refresh_token: "real-refresh-token",
  id_token: "real-id-token",
};

const defaultHandler: UpstreamHandler = (call, response) => {
  if (call.path === "/register") {
    sendJson(response, 201, { client_id: "public-client", redirect_uris: ["http://127.0.0.1/callback"] });

    return;
  }

  sendJson(response, 200, TOKEN_RESPONSE);
};

export interface Upstream {
  server: Server;
  calls: UpstreamCall[];
  handler: { current: UpstreamHandler };
}

export const startUpstream = async (ca: LauncherCa): Promise<Upstream> => {
  const contexts = {
    "auth.test": createSecureContext(await ca.leaf("auth.test")),
    "mcp.test": createSecureContext(await ca.leaf("mcp.test")),
  };
  const calls: UpstreamCall[] = [];
  const handler = { current: defaultHandler };
  const server = createHttpsServer(
    {
      ...(await ca.leaf("auth.test")),
      SNICallback: (name, callback) => callback(null, contexts[name as keyof typeof contexts]),
    },
    (request, response) => {
      void readBody(request).then((body) => {
        const call = {
          host: String(request.headers.host),
          method: request.method ?? "",
          path: request.url ?? "/",
          headers: request.headers,
          body,
        };

        calls.push(call);

        handler.current(call, response);
      });
    },
  );

  await listen(server);

  return { server, calls, handler };
};

export interface VaultProxy {
  test: TestProxy;
  vault: VaultHook;
  token: string;
  otherToken: string;
  opened: string[];
  caPem: string;
}

export interface VaultProxyOptions {
  stateDir: string;
  ca: LauncherCa;
  upstream: Upstream;
  resolver: SecretResolver;
  servers?: VaultServer[];
  pollMs?: number;
  flowTtlMs?: number;
}

export const startVaultProxy = async (options: VaultProxyOptions): Promise<VaultProxy> => {
  await writeProxyDynamic(options.stateDir, POLICY_HASH, {
    version: 1,
    rules: [accessRule],
    derivedHosts: [],
    tokens: {},
    vault: options.servers ?? [vaultServer()],
  });

  const runtime = createProxyRuntime({
    stateDir: options.stateDir,
    policyHash: POLICY_HASH,
    staticRules: [],
    grantsEnabled: false,
    cap: {},
  });
  const opened: string[] = [];
  const vault = createVault({
    stateDir: options.stateDir,
    servers: () => runtime.vault(),
    resolver: options.resolver,
    runner: createFakeRunner(() => undefined).runner,
    openBrowser: async (url) => {
      opened.push(url);
    },
    pollMs: options.pollMs ?? 200,
    flowTtlMs: options.flowTtlMs ?? 60_000,
  });
  const port = portOf(options.upstream.server);
  const test = await startTestProxy({
    stateDir: options.stateDir,
    policy: { allow: [], mcpHosts: [] },
    ca: options.ca,
    resolver: options.resolver,
    grantsEnabled: false,
    ports: () => ({ "auth.test:443": port, "mcp.test:443": port }),
    vault,
  });

  return {
    test,
    vault,
    token: await test.tokenOf(REPO),
    otherToken: await test.tokenOf(OTHER_REPO),
    opened,
    caPem: options.ca.certPem,
  };
};

export const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createNetServer();

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;

      server.close(() => resolve(port));
    });
  });

export const authorizeUrl = (
  port: number,
  params: Record<string, string> = {},
  base = "https://auth.test/authorize",
) => {
  const url = new URL(base);
  const entries = {
    response_type: "code",
    client_id: "public-client",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    redirect_uri: `http://127.0.0.1:${port}/callback`,
    state: "state-1",
    scope: "read write",
    resource: MCP_URL,
    ...params,
  };

  Object.entries(entries)
    .filter(([, value]) => value !== "")
    .forEach(([name, value]) => {
      url.searchParams.set(name, value);
    });

  return url.href;
};

export const hitCallback = (port: number, path: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path }, (response) => {
      void readBody(response).then((body) => resolve({ status: response.statusCode ?? 0, body }));
    });

    request.once("error", reject);

    request.end();
  });

export interface Reply {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}

export const postThrough = async (
  proxy: VaultProxy,
  host: string,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Reply> => {
  const response = await requestThrough({
    proxyPort: proxy.test.proxy.port,
    token: proxy.token,
    host,
    ca: proxy.caPem,
    path,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });

  return { status: response.statusCode ?? 0, headers: response.headers, body: await readBody(response) };
};

export interface SignedIn {
  flow: string;
  port: number;
  code: string;
}

export const startSignIn = async (
  proxy: VaultProxy,
  params: Record<string, string> = {},
): Promise<SignedIn> => {
  const port = await freePort();
  const opened = await proxy.vault.open(REPO, { url: authorizeUrl(port, params) });
  const flow = (opened.body as { flow: string }).flow;

  await hitCallback(port, `/callback?code=real-code-1&state=${params.state ?? "state-1"}`);

  const polled = await proxy.vault.callback(REPO, flow);
  const query = new URLSearchParams((polled.body as { query: string }).query);

  return { flow, port, code: query.get("code") ?? "" };
};

export const exchangeForm = (signedIn: SignedIn, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    grant_type: "authorization_code",
    code: signedIn.code,
    code_verifier: "verifier",
    redirect_uri: `http://127.0.0.1:${signedIn.port}/callback`,
    resource: MCP_URL,
    client_id: "public-client",
    ...extra,
  }).toString();
