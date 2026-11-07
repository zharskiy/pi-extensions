import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { type HttpsFixture, type SeenRequest, sendJson, startHttpsFixture } from "./https-fixture.ts";
import type { TestCertificate } from "./test-ca.ts";

export interface OAuthFixture extends HttpsFixture {
  issuer(host: string): string;
  isValidAccess(token: string): boolean;
  issuedAccess(): string[];
  issuedRefresh(): string[];
  grants(): string[];
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
}

interface OAuthState {
  host: string;
  clients: Set<string>;
  codes: Map<string, PendingCode>;
  access: Map<string, number>;
  refresh: Set<string>;
  issued: { access: string[]; refresh: string[]; grants: string[] };
}

const token = (prefix: string) => `${prefix}-${randomBytes(18).toString("hex")}`;

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

const metadata = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
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

  state.clients.add(clientId);

  sendJson(response, 201, { ...body, client_id: clientId, token_endpoint_auth_method: "none" });
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
): Promise<OAuthFixture> => {
  const state: OAuthState = {
    host,
    clients: new Set(),
    codes: new Map(),
    access: new Map(),
    refresh: new Set(),
    issued: { access: [], refresh: [], grants: [] },
  };
  const holder: { fixture?: HttpsFixture } = {};
  const issuer = () => (holder.fixture?.url(host, "/") ?? "").replace(/\/$/, "");

  const fixture = await startHttpsFixture(certificate, (request, response) => {
    const path = request.path.split("?")[0] ?? "";

    if (path.startsWith("/.well-known/")) {
      sendJson(response, 200, metadata(issuer()));

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
    grants: () => [...state.issued.grants],
  };
};
