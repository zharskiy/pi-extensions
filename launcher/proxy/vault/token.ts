import {
  isCodePlaceholder,
  syntheticExpiresIn,
  type VaultClientInformation,
  type VaultEntry,
  type VaultServer,
  type VaultTokens,
} from "../../shared/index.ts";
import type { HeaderPair } from "../rules.ts";
import type { SecretResolver } from "../secrets/index.ts";
import type { Flow, Flows } from "./callback.ts";
import { readStoreEntry, serverUrlOf, updateStoreEntry, vaultKey } from "./store.ts";

export interface BufferQuery {
  host: string;
  port: number;
  repoHash: string;
  method: string;
  url: string;
  contentType: string;
}

export interface TokenRequest {
  repoHash: string;
  url: string;
  headers: HeaderPair[];
  body: Buffer;
}

export interface TokenResponse {
  status: number;
  headers: HeaderPair[];
  body: Buffer;
}

export interface TokenOutcome {
  reason?: string;
  response: TokenResponse;
}

export type TokenPlan =
  | ({ kind: "answer" } & TokenOutcome)
  | {
      kind: "forward";
      reason?: string;
      strict?: boolean;
      headers: HeaderPair[];
      body: Buffer;
      complete(response: TokenResponse): Promise<TokenOutcome>;
    };

export interface VaultTokenHook {
  buffers(query: BufferQuery): Promise<boolean>;
  plan(request: TokenRequest): Promise<TokenPlan>;
}

export interface TokenDeps {
  stateDir: string;
  servers: (repoHash?: string) => Promise<VaultServer[]>;
  resolver: SecretResolver;
  flows: Flows;
  now: () => number;
}

const FORM_TYPE = "application/x-www-form-urlencoded";

const JSON_TYPE = "application/json";

const TOKEN_FIELDS = ["access_token", "refresh_token", "id_token"];

const EXPIRY_MARGIN_MS = 60_000;

const JSON_HEADERS: HeaderPair[] = [
  ["content-type", JSON_TYPE],
  ["cache-control", "no-store"],
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

const mediaTypeOf = (contentType: string) => (contentType.split(";")[0] ?? "").trim().toLowerCase();

const headerValue = (headers: HeaderPair[], name: string) =>
  headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? "";

const sameUrl = (left: string, right: string) => {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
};

const isFormType = (contentType: string) => mediaTypeOf(contentType) === FORM_TYPE;

const isJsonType = (contentType: string) => mediaTypeOf(contentType) === JSON_TYPE;

const json = (status: number, body: object): TokenResponse => ({
  status,
  headers: JSON_HEADERS,
  body: Buffer.from(JSON.stringify(body)),
});

const oauthError = (status: number, error: string, description: string) =>
  json(status, { error, error_description: `pi-sandbox: ${description}` });

const expiredSignIn = (server: VaultServer) =>
  oauthError(400, "invalid_grant", `the stored sign-in for ${server.server} has expired; sign in again`);

const parseJson = (body: Buffer): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));

    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const parseLoose = (body: Buffer) =>
  parseJson(body) ?? Object.fromEntries(new URLSearchParams(body.toString("utf8")));

const carriesTokens = (body: Record<string, unknown> | undefined) =>
  body !== undefined && TOKEN_FIELDS.some((field) => nonEmpty(body[field]));

const isSuccess = (status: number) => status >= 200 && status < 300;

const expiresInOf = (value: unknown) => {
  const seconds = value === undefined || value === null || value === "" ? undefined : Number(value);

  return seconds !== undefined && Number.isFinite(seconds) ? seconds : undefined;
};

const refused = (): TokenOutcome => ({
  reason: "token response refused",
  response: oauthError(400, "invalid_grant", "token response outside a sandbox sign-in"),
});

const notJson = (endpoint: string): TokenOutcome => ({
  reason: "response refused",
  response: oauthError(502, "server_error", `the ${endpoint} answered with a body that is not JSON`),
});

const answer = (reason: string, status: number, error: string, description: string): TokenPlan => ({
  kind: "answer",
  reason,
  response: oauthError(status, error, description),
});

const withoutTokens = (entry: VaultEntry | undefined) => {
  const { tokens: _tokens, tokensExpireAt: _expiry, ...rest } = entry ?? { serverUrl: "" };

  return rest;
};

const basicCredentials = (headers: HeaderPair[]) => {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(headerValue(headers, "authorization").trim());
  const decoded = match === null ? undefined : Buffer.from(match[1] ?? "", "base64").toString("utf8");
  const separator = decoded?.indexOf(":") ?? -1;

  return decoded === undefined || separator === -1
    ? undefined
    : { user: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
};

const swapBasic = (headers: HeaderPair[], placeholder: string, secret: string | undefined) =>
  headers.map(([name, value]): HeaderPair => {
    const credentials =
      name.toLowerCase() === "authorization" ? basicCredentials([[name, value]]) : undefined;

    if (credentials === undefined || credentials.secret !== placeholder || secret === undefined) {
      return [name, value];
    }

    return [name, `Basic ${Buffer.from(`${credentials.user}:${secret}`).toString("base64")}`];
  });

const authMethodOf = (headers: HeaderPair[], params: URLSearchParams) => {
  if (basicCredentials(headers) !== undefined) {
    return "client_secret_basic";
  }

  return params.has("client_secret") ? "client_secret_post" : "none";
};

export const createTokenHook = (deps: TokenDeps) => {
  const containerTokens = (server: VaultServer, tokens: VaultTokens, expiresAt: number | undefined) => ({
    access_token: server.access,
    token_type: "Bearer",
    ...(nonEmpty(tokens.refresh_token) ? { refresh_token: server.refresh } : {}),
    ...(nonEmpty(tokens.scope) ? { scope: tokens.scope } : {}),
    expires_in: syntheticExpiresIn(
      expiresAt === undefined ? Number.POSITIVE_INFINITY : (expiresAt - deps.now()) / 1000,
    ),
  });

  const answerRefresh = async (server: VaultServer): Promise<TokenOutcome> => {
    const entry = await readStoreEntry(deps.stateDir, server);

    if (entry?.tokens === undefined) {
      return { reason: "refresh refused", response: expiredSignIn(server) };
    }

    if (entry.tokensExpireAt !== undefined && entry.tokensExpireAt - deps.now() <= EXPIRY_MARGIN_MS) {
      deps.resolver.invalidate(server.ruleId);
    }

    const result = await deps.resolver.resolve(server.ruleId, {
      mcpOAuth: { server: server.server, url: server.url },
    });
    const after = await readStoreEntry(deps.stateDir, server);

    if (after?.tokens === undefined) {
      return { reason: "refresh refused", response: expiredSignIn(server) };
    }

    const stillValid = after.tokensExpireAt === undefined || after.tokensExpireAt > deps.now();

    if (!result.ok && !stillValid) {
      return {
        reason: "refresh unavailable",
        response: oauthError(
          503,
          "temporarily_unavailable",
          `the sign-in for ${server.server} could not be refreshed; try again shortly`,
        ),
      };
    }

    return {
      reason: "refresh answered",
      response: json(200, containerTokens(server, after.tokens, after.tokensExpireAt)),
    };
  };

  const bindResponse = async (
    flow: Flow,
    server: VaultServer,
    client: VaultClientInformation,
    response: TokenResponse,
  ): Promise<TokenOutcome> => {
    const body = parseJson(response.body);

    if (body === undefined) {
      await deps.flows.finish(flow.id);

      return notJson("token endpoint");
    }

    if (!carriesTokens(body)) {
      await deps.flows.finish(flow.id);

      return { reason: "code exchange failed", response };
    }

    if (!isSuccess(response.status) || !nonEmpty(body.access_token)) {
      return refused();
    }

    const expiresIn = expiresInOf(body.expires_in);
    const scope = nonEmpty(body.scope) ? body.scope : flow.scope;
    const tokens: VaultTokens = {
      access_token: body.access_token,
      token_type: nonEmpty(body.token_type) ? body.token_type : "Bearer",
      ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
      ...(scope === undefined ? {} : { scope }),
      ...(nonEmpty(body.refresh_token) ? { refresh_token: body.refresh_token } : {}),
    };
    const expiresAt = expiresIn === undefined ? undefined : deps.now() + expiresIn * 1000;

    await updateStoreEntry(deps.stateDir, vaultKey(server.server, server.url), (current) => ({
      ...withoutTokens(current),
      serverUrl: serverUrlOf(server.url),
      clientInformation: client,
      tokens,
      ...(expiresAt === undefined ? {} : { tokensExpireAt: expiresAt }),
    }));

    deps.resolver.invalidate(server.ruleId);

    await deps.flows.finish(flow.id);

    return { reason: "code exchanged", response: json(200, containerTokens(server, tokens, expiresAt)) };
  };

  const exchangePlan = async (
    request: TokenRequest,
    params: URLSearchParams,
    placeholder: string,
  ): Promise<TokenPlan> => {
    const found = deps.flows.byCode(placeholder);
    const flow = found?.flow.repoHash === request.repoHash ? found.flow : undefined;
    const server = (await deps.servers(request.repoHash)).find((entry) => entry.server === flow?.server);
    const matches =
      flow !== undefined &&
      sameUrl(request.url, flow.tokenEndpoint) &&
      params.get("redirect_uri") === flow.redirectUri;

    if (found === undefined || flow === undefined || server === undefined || !matches) {
      return {
        kind: "answer",
        reason: "code refused",
        response: oauthError(400, "invalid_grant", "the authorization code does not belong to this sign-in"),
      };
    }

    const entry = await readStoreEntry(deps.stateDir, server);
    const stored = entry?.clientInformation?.client_secret;
    const secret = nonEmpty(stored) ? stored : undefined;
    const usesPlaceholder = params.get("client_secret") === server.client;
    const headers = swapBasic(request.headers, server.client, secret);
    const basic = basicCredentials(request.headers);
    const sentSecret = usesPlaceholder || basic?.secret === server.client;
    const { client_secret: _previous, ...known } = entry?.clientInformation ?? { client_id: "" };
    const client: VaultClientInformation = {
      ...known,
      client_id: params.get("client_id") ?? basic?.user ?? known.client_id,
      ...(sentSecret && secret !== undefined ? { client_secret: secret } : {}),
      redirect_uris: [flow.redirectUri],
      token_endpoint_auth_method: authMethodOf(request.headers, params),
    };

    if (usesPlaceholder && secret !== undefined) {
      params.set("client_secret", secret);
    }

    params.set("code", found.code);

    return {
      kind: "forward",
      strict: true,
      headers,
      body: Buffer.from(params.toString()),
      complete: (response) => bindResponse(flow, server, client, response),
    };
  };

  const registered = async (servers: VaultServer[], response: TokenResponse): Promise<TokenOutcome> => {
    const body = parseJson(response.body);

    if (body === undefined) {
      return notJson("registration endpoint");
    }

    const secret = body.client_secret;
    const sensitive = nonEmpty(secret) || body.registration_access_token !== undefined;

    if (!sensitive || !isSuccess(response.status)) {
      return { response };
    }

    const [server] = servers;

    if (server === undefined || servers.length > 1) {
      return {
        reason: "registration refused",
        response: oauthError(
          400,
          "invalid_client_metadata",
          "this registration endpoint serves several MCP servers; sign in with pi mcp login <name>",
        ),
      };
    }

    await updateStoreEntry(deps.stateDir, vaultKey(server.server, server.url), (current) => ({
      ...(current ?? {}),
      serverUrl: serverUrlOf(server.url),
      clientInformation: body as VaultClientInformation,
    }));

    const { registration_access_token: _hidden, ...visible } = body;

    return {
      reason: "client registered",
      response: json(
        response.status,
        nonEmpty(secret) ? { ...visible, client_secret: server.client } : visible,
      ),
    };
  };

  const registrationPlan = (servers: VaultServer[], request: TokenRequest): TokenPlan => {
    if (!isJsonType(headerValue(request.headers, "content-type"))) {
      return answer(
        "registration refused",
        400,
        "invalid_client_metadata",
        "a registration body must be JSON",
      );
    }

    return {
      kind: "forward",
      strict: true,
      headers: request.headers,
      body: request.body,
      complete: (response) => registered(servers, response),
    };
  };

  const unbound = async (response: TokenResponse): Promise<TokenOutcome> =>
    carriesTokens(parseLoose(response.body)) ? refused() : { response };

  const tokenEndpointAnswer = async (response: TokenResponse): Promise<TokenOutcome> => {
    const body = parseJson(response.body);

    if (body === undefined) {
      return notJson("token endpoint");
    }

    return carriesTokens(body) ? refused() : { response };
  };

  const registrationServers = (servers: VaultServer[], url: string) =>
    servers.filter(
      (server) =>
        server.discovery.registrationEndpoint !== undefined &&
        sameUrl(server.discovery.registrationEndpoint, url),
    );

  const isTokenEndpoint = (servers: VaultServer[], url: string) =>
    servers.some((server) => sameUrl(server.discovery.tokenEndpoint, url));

  const isEndpoint = async (url: string, repoHash: string) => {
    const servers = await deps.servers(repoHash);

    return isTokenEndpoint(servers, url) || registrationServers(servers, url).length > 0;
  };

  const buffers = async (query: BufferQuery) =>
    (query.method === "POST" && isFormType(query.contentType)) ||
    (await isEndpoint(query.url, query.repoHash));

  const plan = async (request: TokenRequest): Promise<TokenPlan> => {
    const servers = await deps.servers(request.repoHash);
    const registration = registrationServers(servers, request.url);

    if (registration.length > 0) {
      return registrationPlan(registration, request);
    }

    const tokenEndpoint = isTokenEndpoint(servers, request.url);

    if (!isFormType(headerValue(request.headers, "content-type"))) {
      return tokenEndpoint
        ? answer("token request refused", 400, "invalid_request", "a token request body must be form-encoded")
        : { kind: "forward", headers: request.headers, body: request.body, complete: unbound };
    }

    const params = new URLSearchParams(request.body.toString("utf8"));
    const refreshToken = params.get("refresh_token");
    const server = servers.find((entry) => refreshToken !== null && entry.refresh === refreshToken);

    if (server !== undefined) {
      return { kind: "answer", ...(await answerRefresh(server)) };
    }

    const code = params.get("code");

    if (code !== null && isCodePlaceholder(code)) {
      return exchangePlan(request, params, code);
    }

    return tokenEndpoint
      ? {
          kind: "forward",
          strict: true,
          headers: request.headers,
          body: request.body,
          complete: tokenEndpointAnswer,
        }
      : { kind: "forward", headers: request.headers, body: request.body, complete: unbound };
  };

  return { buffers, plan };
};
