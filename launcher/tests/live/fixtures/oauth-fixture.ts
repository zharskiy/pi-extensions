import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { type HttpsFixture, type SeenRequest, sendJson, startHttpsFixture } from "./https-fixture.ts";
import type { TestCertificate } from "./test-ca.ts";

export type ClientAuth = "none" | "client_secret_basic" | "client_secret_post";

export interface OAuthFixtureOptions {
  clientAuth?: ClientAuth;
}

export interface OAuthFixture extends HttpsFixture {
  issuer(host: string): string;
  isValidAccess(token: string): boolean;
  issuedAccess(): string[];
  issuedRefresh(): string[];
  issuedCodes(): string[];
  issuedSecrets(): string[];
  grants(): string[];
  revokeAll(): void;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
}

interface OAuthState {
  host: string;
  clientAuth: ClientAuth;
  clients: Map<string, string | undefined>;
  codes: Map<string, PendingCode>;
  access: Map<string, number>;
  refresh: Set<string>;
  issued: { access: string[]; refresh: string[]; codes: string[]; secrets: string[]; grants: string[] };
}

const token = (prefix: string) => `${prefix}-${randomBytes(18).toString("hex")}`;

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

const metadata = (issuer: string, clientAuth: ClientAuth) => ({
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: [clientAuth],
  authorization_response_iss_parameter_supported: true,
});

const issueTokens = (state: OAuthState, lifetimeSeconds: number, response: ServerResponse) => {
  const access = token("fixture-access");
  const refresh = token("fixture-refresh");

  state.access.set(access, Date.now() + lifetimeSeconds * 1000);

  state.refresh.add(refresh);

  state.issued.access.push(access);

  state.issued.refresh.push(refresh);

  sendJson(response, 200, {
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: lifetimeSeconds,
  });
};

const register = (state: OAuthState, request: SeenRequest, response: ServerResponse) => {
  const body = JSON.parse(request.body) as Record<string, unknown>;
  const clientId = token("fixture-client");

  if (state.clientAuth === "none") {
    state.clients.set(clientId, undefined);

    sendJson(response, 201, { ...body, client_id: clientId, token_endpoint_auth_method: "none" });

    return;
  }

  const secret = token("fixture-secret");

  state.clients.set(clientId, secret);

  state.issued.secrets.push(secret);

  sendJson(response, 201, {
    ...body,
    client_id: clientId,
    client_secret: secret,
    token_endpoint_auth_method: state.clientAuth,
  });
};

const basicCredentials = (request: SeenRequest) => {
  const header = String(request.headers.authorization ?? "");

  if (!header.startsWith("Basic ")) {
    return { id: "", secret: "" };
  }

  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const colon = decoded.indexOf(":");

  return colon < 0
    ? { id: "", secret: "" }
    : {
        id: decodeURIComponent(decoded.slice(0, colon)),
        secret: decodeURIComponent(decoded.slice(colon + 1)),
      };
};

const presentedCredentials = (state: OAuthState, request: SeenRequest, form: URLSearchParams) =>
  state.clientAuth === "client_secret_basic"
    ? basicCredentials(request)
    : { id: form.get("client_id") ?? "", secret: form.get("client_secret") ?? "" };

const isAuthenticated = (state: OAuthState, request: SeenRequest, form: URLSearchParams) => {
  if (state.clientAuth === "none") {
    return true;
  }

  const presented = presentedCredentials(state, request, form);
  const expected = state.clients.get(presented.id);

  return expected !== undefined && expected === presented.secret;
};

const authorize = (state: OAuthState, request: SeenRequest, response: ServerResponse, issuer: string) => {
  const query = new URL(request.path, issuer).searchParams;
  const clientId = query.get("client_id") ?? "";
  const redirectUri = query.get("redirect_uri") ?? "";
  const code = token("fixture-code");

  if (!state.clients.has(clientId) || query.get("code_challenge_method") !== "S256") {
    sendJson(response, 400, { error: "invalid_request" });

    return;
  }

  state.codes.set(code, { clientId, redirectUri, challenge: query.get("code_challenge") ?? "" });

  state.issued.codes.push(code);

  const location = new URL(redirectUri);

  location.searchParams.set("code", code);

  location.searchParams.set("state", query.get("state") ?? "");

  location.searchParams.set("iss", issuer);

  response.writeHead(302, { location: location.href });

  response.end();
};

const exchange = (state: OAuthState, form: URLSearchParams, lifetime: number, response: ServerResponse) => {
  const pending = state.codes.get(form.get("code") ?? "");

  state.codes.delete(form.get("code") ?? "");

  if (
    pending === undefined ||
    pending.redirectUri !== form.get("redirect_uri") ||
    pending.challenge !== challengeOf(form.get("code_verifier") ?? "")
  ) {
    sendJson(response, 400, { error: "invalid_grant" });

    return;
  }

  state.issued.grants.push("authorization_code");

  issueTokens(state, lifetime, response);
};

const refresh = (state: OAuthState, form: URLSearchParams, lifetime: number, response: ServerResponse) => {
  const presented = form.get("refresh_token") ?? "";

  if (!state.refresh.delete(presented)) {
    sendJson(response, 400, { error: "invalid_grant" });

    return;
  }

  state.issued.grants.push("refresh_token");

  issueTokens(state, lifetime, response);
};

export const startOAuthFixture = async (
  certificate: TestCertificate,
  host: string,
  lifetimeSeconds = 60,
  options: OAuthFixtureOptions = {},
): Promise<OAuthFixture> => {
  const state: OAuthState = {
    host,
    clientAuth: options.clientAuth ?? "none",
    clients: new Map(),
    codes: new Map(),
    access: new Map(),
    refresh: new Set(),
    issued: { access: [], refresh: [], codes: [], secrets: [], grants: [] },
  };
  const holder: { fixture?: HttpsFixture } = {};
  const issuer = () => (holder.fixture?.url(host, "/") ?? "").replace(/\/$/, "");

  const fixture = await startHttpsFixture(certificate, (request, response) => {
    const path = request.path.split("?")[0] ?? "";

    if (path.startsWith("/.well-known/")) {
      sendJson(response, 200, metadata(issuer(), state.clientAuth));

      return;
    }

    if (path === "/register" && request.method === "POST") {
      register(state, request, response);

      return;
    }

    if (path === "/authorize") {
      authorize(state, request, response, issuer());

      return;
    }

    if (path === "/token" && request.method === "POST") {
      const form = new URLSearchParams(request.body);

      if (!isAuthenticated(state, request, form)) {
        sendJson(response, 401, { error: "invalid_client" });

        return;
      }

      if (form.get("grant_type") === "refresh_token") {
        refresh(state, form, lifetimeSeconds, response);

        return;
      }

      exchange(state, form, lifetimeSeconds, response);

      return;
    }

    sendJson(response, 404, { error: "not found" });
  });

  holder.fixture = fixture;

  return {
    ...fixture,
    issuer,
    isValidAccess: (value) => (state.access.get(value) ?? 0) > Date.now(),
    issuedAccess: () => [...state.issued.access],
    issuedRefresh: () => [...state.issued.refresh],
    issuedCodes: () => [...state.issued.codes],
    issuedSecrets: () => [...state.issued.secrets],
    grants: () => [...state.issued.grants],
    revokeAll: () => {
      state.access.clear();

      state.refresh.clear();
    },
  };
};
