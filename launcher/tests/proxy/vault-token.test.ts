import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SecretResolver, SecretResult } from "../../proxy/secrets/index.ts";
import type { LauncherCa } from "../../proxy/tls-ca.ts";
import { readVaultStore, type VaultEntry, writeVaultEntry } from "../../shared/index.ts";
import { closeServer, createStateDir, openCa, removeDir } from "./harness.ts";
import { requestThrough } from "./proxy-client.ts";
import {
  exchangeForm,
  MCP_URL,
  PLACEHOLDERS,
  postThrough,
  RULE_ID,
  sendJson,
  startSignIn,
  startUpstream,
  startVaultProxy,
  type Upstream,
  type VaultProxy,
} from "./vault-fixture.ts";

const KEY = `mcp__docs|${new URL(MCP_URL).href}`;

const shared: { caDir: string; ca: LauncherCa; upstream: Upstream } = {
  caDir: "",
  ca: undefined as unknown as LauncherCa,
  upstream: undefined as unknown as Upstream,
};

const state: {
  stateDir: string;
  proxy: VaultProxy;
  result: SecretResult;
  invalidated: string[];
  resolves: number;
} = {
  stateDir: "",
  proxy: undefined as unknown as VaultProxy,
  result: { ok: true, value: "real-access-token" },
  invalidated: [],
  resolves: 0,
};

const resolver: SecretResolver = {
  resolve: async () => {
    state.resolves += 1;

    return state.result;
  },
  invalidate: (key) => {
    state.invalidated.push(key);
  },
};

beforeAll(async () => {
  shared.caDir = await createStateDir();
  shared.ca = await openCa(shared.caDir);
  shared.upstream = await startUpstream(shared.ca);
}, 30_000);

afterAll(async () => {
  await closeServer(shared.upstream.server);

  await removeDir(shared.caDir);
});

beforeEach(async () => {
  state.stateDir = await createStateDir();
  state.result = { ok: true, value: "real-access-token" };
  state.invalidated = [];
  state.resolves = 0;
  shared.upstream.calls.length = 0;
  shared.upstream.handler.current = (call, response) =>
    call.path === "/register"
      ? sendJson(response, 201, { client_id: "public-client" })
      : sendJson(response, 200, {
          access_token: "real-access-token",
          token_type: "Bearer",
          expires_in: 7200,
          refresh_token: "real-refresh-token",
          id_token: "real-id-token",
        });
  state.proxy = await startVaultProxy({
    stateDir: state.stateDir,
    ca: shared.ca,
    upstream: shared.upstream,
    resolver,
  });
});

afterEach(async () => {
  await state.proxy.test.proxy.close();

  await removeDir(state.stateDir);
});

const storedEntry = async (): Promise<VaultEntry | undefined> => (await readVaultStore(state.stateDir))[KEY];

const realValues = ["real-access-token", "real-refresh-token", "real-id-token", "real-code-1", "real-secret"];

const expectNoRealValues = (text: string) => {
  realValues.forEach((value) => {
    expect(text).not.toContain(value);
  });
};

describe("vault code exchange", () => {
  it("swaps the code placeholder in at the flow's token endpoint and returns placeholders", async () => {
    const signedIn = await startSignIn(state.proxy);
    const reply = await postThrough(state.proxy, "auth.test", "/token", exchangeForm(signedIn));
    const upstream = new URLSearchParams(shared.upstream.calls.at(-1)?.body ?? "");

    expect(signedIn.code).toMatch(/^pi-sandbox-code-[0-9a-f]{32}$/);
    expect(upstream.get("code")).toBe("real-code-1");
    expect(shared.upstream.calls.at(-1)?.headers["accept-encoding"]).toBeUndefined();
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({
      access_token: PLACEHOLDERS.access,
      token_type: "Bearer",
      refresh_token: PLACEHOLDERS.refresh,
      scope: "read write",
      expires_in: 3600,
    });
    expectNoRealValues(reply.body);
    expectNoRealValues(JSON.stringify(state.proxy.test.log));
    expect(state.invalidated).toContain(RULE_ID);
    expect(state.proxy.test.log).toContainEqual(
      expect.objectContaining({ host: "auth.test", rule: "vault", reason: "code exchanged" }),
    );
  });

  it("writes the host entry with the server URL, client information, real tokens and their expiry", async () => {
    const before = Date.now();
    const signedIn = await startSignIn(state.proxy);

    await postThrough(state.proxy, "auth.test", "/token", exchangeForm(signedIn));

    const entry = await storedEntry();

    expect(entry).toMatchObject({
      serverUrl: MCP_URL,
      clientInformation: {
        client_id: "public-client",
        redirect_uris: [`http://127.0.0.1:${signedIn.port}/callback`],
        token_endpoint_auth_method: "none",
      },
      tokens: {
        access_token: "real-access-token",
        token_type: "Bearer",
        expires_in: 7200,
        scope: "read write",
        refresh_token: "real-refresh-token",
      },
    });
    expect(JSON.stringify(entry)).not.toContain("real-id-token");
    expect(entry?.tokensExpireAt).toBeGreaterThanOrEqual(before + 7_200_000);
  });

  it("uses the floor of 300 s for a short-lived token", async () => {
    shared.upstream.handler.current = (_call, response) =>
      sendJson(response, 200, { access_token: "real-access-token", token_type: "Bearer", expires_in: 60 });

    const signedIn = await startSignIn(state.proxy);
    const reply = JSON.parse(
      (await postThrough(state.proxy, "auth.test", "/token", exchangeForm(signedIn))).body,
    );

    expect(reply).toEqual({
      access_token: PLACEHOLDERS.access,
      token_type: "Bearer",
      scope: "read write",
      expires_in: 300,
    });
  });

  it("refuses the code placeholder at another endpoint or with another redirect_uri, without calling upstream", async () => {
    const signedIn = await startSignIn(state.proxy);
    const elsewhere = await postThrough(state.proxy, "auth.test", "/other-token", exchangeForm(signedIn));
    const redirected = await postThrough(
      state.proxy,
      "auth.test",
      "/token",
      exchangeForm(signedIn, { redirect_uri: "http://127.0.0.1:1/callback" }),
    );

    expect([elsewhere.status, redirected.status]).toEqual([400, 400]);
    expect(JSON.parse(elsewhere.body)).toMatchObject({ error: "invalid_grant" });
    expect(JSON.parse(redirected.body)).toMatchObject({ error: "invalid_grant" });
    expect(shared.upstream.calls).toEqual([]);
  });

  it("accepts the code placeholder only once", async () => {
    const signedIn = await startSignIn(state.proxy);

    await postThrough(state.proxy, "auth.test", "/token", exchangeForm(signedIn));

    const again = await postThrough(state.proxy, "auth.test", "/token", exchangeForm(signedIn));

    expect(again.status).toBe(400);
    expect(shared.upstream.calls).toHaveLength(1);
  });

  it("discards a token response outside a sandbox sign-in", async () => {
    const reply = await postThrough(
      state.proxy,
      "auth.test",
      "/token",
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: "pasted-real-token" }).toString(),
    );

    expect(shared.upstream.calls).toHaveLength(1);
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body)).toEqual({
      error: "invalid_grant",
      error_description: "pi-sandbox: token response outside a sandbox sign-in",
    });
    expectNoRealValues(reply.body);
    expect(await storedEntry()).toBeUndefined();
  });

  it("passes an error response without tokens through", async () => {
    shared.upstream.handler.current = (_call, response) =>
      sendJson(response, 400, { error: "invalid_request", error_description: "bad" });

    const reply = await postThrough(state.proxy, "auth.test", "/token", "grant_type=client_credentials");

    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body)).toEqual({ error: "invalid_request", error_description: "bad" });
  });

  it("refuses a compressed token response with 502", async () => {
    shared.upstream.handler.current = (_call, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });

      response.end(gzipSync(JSON.stringify({ access_token: "real-access-token", token_type: "Bearer" })));
    };

    const signedIn = await startSignIn(state.proxy);
    const reply = await postThrough(state.proxy, "auth.test", "/token", exchangeForm(signedIn));

    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body)).toEqual({ error: "pi-sandbox: compressed token response refused" });
  });

  it("streams an event-stream response to a form POST without buffering it", async () => {
    const release: { current: () => void } = { current: () => undefined };

    shared.upstream.handler.current = (_call, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });

      response.write("data: first\n\n");

      release.current = () => response.end("data: last\n\n");
    };

    const response = await requestThrough({
      proxyPort: state.proxy.test.proxy.port,
      token: state.proxy.token,
      host: "mcp.test",
      ca: state.proxy.caPem,
      path: "/events",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    const first = await new Promise<string>((resolve) =>
      response.once("data", (chunk: Buffer) => resolve(String(chunk))),
    );

    release.current();

    expect(first).toBe("data: first\n\n");
  });
});

describe("vault refresh", () => {
  const signedInEntry = (tokensExpireAt: number): VaultEntry => ({
    serverUrl: MCP_URL,
    clientInformation: { client_id: "public-client" },
    tokens: {
      access_token: "real-access-token",
      token_type: "Bearer",
      scope: "read",
      refresh_token: "real-refresh-token",
    },
    tokensExpireAt,
  });

  const refreshForm = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: PLACEHOLDERS.refresh,
    client_id: "public-client",
  }).toString();

  it("answers a placeholder refresh on any vault host without calling upstream", async () => {
    await writeVaultEntry(state.stateDir, KEY, signedInEntry(Date.now() + 1_800_000));

    const reply = await postThrough(state.proxy, "mcp.test", "/anything", refreshForm);

    expect(shared.upstream.calls).toEqual([]);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({
      access_token: PLACEHOLDERS.access,
      token_type: "Bearer",
      refresh_token: PLACEHOLDERS.refresh,
      scope: "read",
      expires_in: expect.any(Number),
    });
    expect(JSON.parse(reply.body).expires_in).toBeGreaterThan(1790);
    expect(JSON.parse(reply.body).expires_in).toBeLessThanOrEqual(1800);
    expectNoRealValues(reply.body);
  });

  it("forces a host refresh within 60 s of expiry", async () => {
    await writeVaultEntry(state.stateDir, KEY, signedInEntry(Date.now() + 30_000));

    await postThrough(state.proxy, "auth.test", "/token", refreshForm);

    expect(state.invalidated).toEqual([RULE_ID]);
    expect(state.resolves).toBe(1);
  });

  it("answers invalid_grant once the stored sign-in is gone", async () => {
    state.result = { ok: false, reason: "no valid token" };

    await writeVaultEntry(state.stateDir, KEY, { serverUrl: MCP_URL });

    const reply = await postThrough(state.proxy, "auth.test", "/token", refreshForm);

    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body)).toEqual({
      error: "invalid_grant",
      error_description: "pi-sandbox: the stored sign-in for docs has expired; sign in again",
    });
  });

  it("answers temporarily_unavailable when tokens remain but the host refresh failed", async () => {
    state.result = { ok: false, reason: "refresh failed" };

    await writeVaultEntry(state.stateDir, KEY, signedInEntry(Date.now() - 1000));

    const reply = await postThrough(state.proxy, "auth.test", "/token", refreshForm);

    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ error: "temporarily_unavailable" });
  });
});

describe("vault client registration", () => {
  const register = () =>
    postThrough(
      state.proxy,
      "auth.test",
      "/register",
      JSON.stringify({ redirect_uris: ["http://127.0.0.1:40000/callback"], client_name: "pi" }),
      { "content-type": "application/json" },
    );

  it("passes a public client registration through and keeps exchanging without a secret", async () => {
    const registered = await register();
    const signedIn = await startSignIn(state.proxy);

    await postThrough(state.proxy, "auth.test", "/token", exchangeForm(signedIn));

    expect(registered.status).toBe(201);
    expect(JSON.parse(registered.body)).toEqual({ client_id: "public-client" });
    expect((await storedEntry())?.clientInformation).toEqual({
      client_id: "public-client",
      redirect_uris: [`http://127.0.0.1:${signedIn.port}/callback`],
      token_endpoint_auth_method: "none",
    });
  });

  it("keeps a confidential client's secret on the host and swaps it back in the form", async () => {
    shared.upstream.handler.current = (call, response) =>
      call.path === "/register"
        ? sendJson(response, 201, {
            client_id: "secret-client",
            client_secret: "real-secret",
            registration_access_token: "real-registration-token",
          })
        : sendJson(response, 200, {
            access_token: "real-access-token",
            token_type: "Bearer",
            expires_in: 7200,
          });

    const registered = await register();
    const visible = JSON.parse(registered.body);
    const signedIn = await startSignIn(state.proxy);
    const reply = await postThrough(
      state.proxy,
      "auth.test",
      "/token",
      exchangeForm(signedIn, { client_id: "secret-client", client_secret: visible.client_secret }),
    );
    const upstream = new URLSearchParams(shared.upstream.calls.at(-1)?.body ?? "");

    expect(visible).toEqual({ client_id: "secret-client", client_secret: PLACEHOLDERS.client });
    expect(registered.body).not.toContain("real-registration-token");
    expect(upstream.get("client_secret")).toBe("real-secret");
    expect(reply.status).toBe(200);
    expectNoRealValues(reply.body);
    expect((await storedEntry())?.clientInformation).toMatchObject({
      client_id: "secret-client",
      client_secret: "real-secret",
      token_endpoint_auth_method: "client_secret_post",
    });
  });

  it("swaps the client placeholder back inside a Basic header", async () => {
    shared.upstream.handler.current = (call, response) =>
      call.path === "/register"
        ? sendJson(response, 201, { client_id: "secret-client", client_secret: "real-secret" })
        : sendJson(response, 200, { access_token: "real-access-token", token_type: "Bearer" });

    await register();

    const signedIn = await startSignIn(state.proxy);
    const basic = Buffer.from(`secret-client:${PLACEHOLDERS.client}`).toString("base64");
    const form = new URLSearchParams(exchangeForm(signedIn));

    form.delete("client_id");

    await postThrough(state.proxy, "auth.test", "/token", form.toString(), {
      authorization: `Basic ${basic}`,
    });

    expect(shared.upstream.calls.at(-1)?.headers.authorization).toBe(
      `Basic ${Buffer.from("secret-client:real-secret").toString("base64")}`,
    );
    expect((await storedEntry())?.clientInformation).toMatchObject({
      client_id: "secret-client",
      client_secret: "real-secret",
      token_endpoint_auth_method: "client_secret_basic",
    });
  });
});
