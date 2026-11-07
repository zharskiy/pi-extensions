import { connect, createServer, type Server } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LauncherCa } from "../../proxy/tls-ca.ts";
import { OAUTH_CALLBACK_STATUS, OAUTH_ROUTES } from "../../proxy/vault/protocol.ts";
import { CONTROL_TOKEN, closeServer, createStateDir, fakeResolver, openCa, removeDir } from "./harness.ts";
import { CONTROL_USER, plainRequest } from "./proxy-client.ts";
import {
  authorizeUrl,
  freePort,
  hitCallback,
  OTHER_REPO,
  REPO,
  startSignIn,
  startUpstream,
  startVaultProxy,
  type Upstream,
  type VaultProxy,
  vaultServer,
} from "./vault-fixture.ts";

const shared: { caDir: string; ca: LauncherCa; upstream: Upstream } = {
  caDir: "",
  ca: undefined as unknown as LauncherCa,
  upstream: undefined as unknown as Upstream,
};

const state: { stateDir: string; proxy: VaultProxy } = {
  stateDir: "",
  proxy: undefined as unknown as VaultProxy,
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

const start = async (flowTtlMs = 60_000, servers = [vaultServer()]) => {
  state.stateDir = await createStateDir();
  state.proxy = await startVaultProxy({
    stateDir: state.stateDir,
    ca: shared.ca,
    upstream: shared.upstream,
    resolver: fakeResolver({}).resolver,
    servers,
    flowTtlMs,
  });
};

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await state.proxy.test.proxy.close();

  await removeDir(state.stateDir);
});

const open = (url: string, repoHash = REPO) => state.proxy.vault.open(repoHash, { url });

const bindable = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server: Server = createServer();

    server.once("error", () => resolve(false));

    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

const errorOf = (reply: { body?: object }) => (reply.body as { error?: string }).error ?? "";

describe("POST /oauth/open", () => {
  it("accepts a pi-shaped authorization URL, binds the callback port and opens the host browser", async () => {
    const port = await freePort();
    const url = authorizeUrl(port);
    const reply = await open(url);

    expect(reply).toEqual({
      status: 200,
      body: { ok: true, flow: expect.any(String), port, path: "/callback" },
    });
    expect(state.proxy.opened).toEqual([url]);
    expect(await bindable(port)).toBe(false);
  });

  it("accepts a localhost redirect, a callback id path and prompt=consent", async () => {
    const port = await freePort();
    const reply = await open(
      authorizeUrl(port, { redirect_uri: `http://localhost:${port}/callback/abc123`, prompt: "consent" }),
    );

    expect(reply.body).toMatchObject({ ok: true, path: "/callback/abc123" });
  });

  it.each([
    ["an http URL", (port: number) => authorizeUrl(port).replace("https:", "http:"), "only https"],
    [
      "an unknown endpoint",
      (port: number) => authorizeUrl(port, {}, "https://auth.test/other"),
      "not the authorization endpoint",
    ],
    [
      "another host",
      (port: number) => authorizeUrl(port, {}, "https://evil.test/authorize"),
      "not the authorization endpoint",
    ],
    [
      "userinfo",
      (port: number) => authorizeUrl(port, {}, "https://user:pass@auth.test/authorize"),
      "credentials",
    ],
    [
      "an extra parameter",
      (port: number) => authorizeUrl(port, { login_hint: "me" }),
      "unexpected parameter login_hint",
    ],
    ["another prompt", (port: number) => authorizeUrl(port, { prompt: "login" }), "prompt=consent"],
    ["a plain challenge", (port: number) => authorizeUrl(port, { code_challenge_method: "plain" }), "S256"],
    ["no state", (port: number) => authorizeUrl(port, { state: "" }), "state"],
    [
      "a remote redirect",
      (port: number) => authorizeUrl(port, { redirect_uri: `http://evil.test:${port}/callback` }),
      "redirect_uri",
    ],
    ["a low port", () => authorizeUrl(8080), "redirect_uri"],
    [
      "another callback path",
      (port: number) => authorizeUrl(port, { redirect_uri: `http://127.0.0.1:${port}/steal` }),
      "redirect_uri",
    ],
  ])("refuses %s", async (_name, build, message) => {
    const port = await freePort();
    const reply = await open(build(port));

    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toContain(message);
    expect(errorOf(reply).startsWith("pi-sandbox: ")).toBe(true);
    expect(state.proxy.opened).toEqual([]);
  });

  it("refuses a URL longer than 8 KiB", async () => {
    const reply = await open(authorizeUrl(await freePort(), { scope: "s".repeat(9000) }));

    expect(errorOf(reply)).toContain("8 KiB");
  });

  it("accepts only the configured callback port when one is set", async () => {
    await state.proxy.test.proxy.close();

    await removeDir(state.stateDir);

    const fixed = await freePort();

    await start(60_000, [vaultServer({ oauth: { callbackPort: fixed } })]);

    const other = await open(authorizeUrl(await freePort()));
    const configured = await open(authorizeUrl(fixed));

    expect(other.status).toBe(400);
    expect(configured.status).toBe(200);
  });

  it("refuses the sixth open within ten minutes", async () => {
    const statuses = await [1, 2, 3, 4, 5, 6].reduce<Promise<number[]>>(async (previous) => {
      const done = await previous;
      const reply = await open(authorizeUrl(await freePort()));

      return [...done, reply.status];
    }, Promise.resolve([]));
    const other = await open(authorizeUrl(await freePort()), OTHER_REPO);

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(other.status).toBe(200);
  });

  it("answers 409 when the callback port is in use on the host", async () => {
    const port = await freePort();
    const holder = createServer();

    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", () => resolve()));

    const reply = await open(authorizeUrl(port));

    await new Promise<void>((resolve) => holder.close(() => resolve()));

    expect(reply).toEqual({
      status: 409,
      body: {
        ok: false,
        error: `pi-sandbox: port ${port} is in use on the host; close the program using it and sign in again`,
      },
    });
  });

  it("answers 409 when the endpoint serves several servers and resource does not pick one", async () => {
    await state.proxy.test.proxy.close();

    await removeDir(state.stateDir);

    const second = vaultServer({
      server: "notes",
      url: "https://mcp.test/notes",
      ruleId: "derived:mcp:notes:oauth",
    });

    await start(60_000, [
      vaultServer(),
      { ...second, discovery: { ...second.discovery, resource: "https://mcp.test/notes" } },
    ]);

    const ambiguous = await open(authorizeUrl(await freePort(), { resource: "" }));
    const picked = await open(authorizeUrl(await freePort(), { resource: "https://mcp.test/notes" }));

    expect(ambiguous.status).toBe(409);
    expect(errorOf(ambiguous)).toBe(
      "pi-sandbox: auth.test serves several MCP servers; sign in with pi mcp login <name>",
    );
    expect(picked.status).toBe(200);
  });

  it("closes the old listener when a new open replaces the pending flow", async () => {
    const firstPort = await freePort();
    const first = await open(authorizeUrl(firstPort));
    const second = await open(authorizeUrl(await freePort()));
    const flow = (first.body as { flow: string }).flow;

    expect(second.status).toBe(200);
    expect(await bindable(firstPort)).toBe(true);
    expect((await state.proxy.vault.callback(REPO, flow)).status).toBe(OAUTH_CALLBACK_STATUS.gone);
  });
});

describe("callback relay", () => {
  it("hands the poller the code placeholder, never the real code, and closes the listener", async () => {
    const port = await freePort();
    const flow = ((await open(authorizeUrl(port))).body as { flow: string }).flow;
    const browser = await hitCallback(
      port,
      "/callback?code=real-code-1&state=state-1&iss=https%3A%2F%2Fauth.test",
    );
    const polled = await state.proxy.vault.callback(REPO, flow);
    const query = new URLSearchParams((polled.body as { query: string }).query);

    expect(browser).toEqual({ status: 200, body: "Signed in. Return to pi." });
    expect(polled.status).toBe(OAUTH_CALLBACK_STATUS.ready);
    expect(query.get("code")).toMatch(/^pi-sandbox-code-[0-9a-f]{32}$/);
    expect(query.get("state")).toBe("state-1");
    expect(query.get("iss")).toBe("https://auth.test");
    expect(JSON.stringify(polled)).not.toContain("real-code-1");
    expect(await bindable(port)).toBe(true);
  });

  it("passes an error through without a code", async () => {
    const port = await freePort();
    const flow = ((await open(authorizeUrl(port))).body as { flow: string }).flow;

    await hitCallback(port, "/callback?error=access_denied&state=state-1");

    const query = new URLSearchParams(
      ((await state.proxy.vault.callback(REPO, flow)).body as { query: string }).query,
    );

    expect(Object.fromEntries(query)).toEqual({ error: "access_denied", state: "state-1" });
  });

  it("answers an unparseable callback target with 400 and keeps the flow pending", async () => {
    const port = await freePort();
    const flow = ((await open(authorizeUrl(port))).body as { flow: string }).flow;
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port }, () =>
        socket.write("GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n"),
      );
      const chunks: Buffer[] = [];

      socket.on("data", (chunk: Buffer) => chunks.push(chunk));

      socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));

      socket.once("error", reject);
    });

    expect(raw.split(" ")[1]).toBe("400");
    expect((await state.proxy.vault.callback(REPO, flow)).status).toBe(OAUTH_CALLBACK_STATUS.pending);
    expect((await hitCallback(port, "/callback?code=x&state=state-1")).status).toBe(200);
  });

  it("answers a wrong state or path with 400 and keeps the flow pending", async () => {
    const port = await freePort();
    const flow = ((await open(authorizeUrl(port))).body as { flow: string }).flow;
    const wrongState = await hitCallback(port, "/callback?code=x&state=other");
    const wrongPath = await hitCallback(port, "/elsewhere?code=x&state=state-1");

    expect([wrongState.status, wrongPath.status]).toEqual([400, 400]);
    expect((await state.proxy.vault.callback(REPO, flow)).status).toBe(OAUTH_CALLBACK_STATUS.pending);
  });

  it("frees the port on cancel and on expiry", async () => {
    const cancelledPort = await freePort();
    const cancelled = ((await open(authorizeUrl(cancelledPort))).body as { flow: string }).flow;

    expect(await state.proxy.vault.cancel(REPO, cancelled)).toEqual({ status: 200, body: { ok: true } });
    expect(await bindable(cancelledPort)).toBe(true);
    expect((await state.proxy.vault.callback(REPO, cancelled)).status).toBe(OAUTH_CALLBACK_STATUS.gone);

    await state.proxy.test.proxy.close();

    await removeDir(state.stateDir);

    await start(100);

    const expiringPort = await freePort();
    const expiring = ((await open(authorizeUrl(expiringPort))).body as { flow: string }).flow;

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await bindable(expiringPort)).toBe(true);
    expect((await state.proxy.vault.callback(REPO, expiring)).status).toBe(OAUTH_CALLBACK_STATUS.gone);
  });

  it("answers another repository's poll and cancel with 404", async () => {
    const signedIn = await startSignIn(state.proxy);

    expect((await state.proxy.vault.callback(OTHER_REPO, signedIn.flow)).status).toBe(404);
    expect((await state.proxy.vault.cancel(OTHER_REPO, signedIn.flow)).status).toBe(404);
    expect((await state.proxy.vault.callback(REPO, signedIn.flow)).status).toBe(OAUTH_CALLBACK_STATUS.ready);
  });
});

describe("/oauth routes on the proxy", () => {
  const route = (path: string, options: { token?: string; user?: string; method?: string; body?: string }) =>
    plainRequest(state.proxy.test.proxy.port, path, options);

  it("answers 407 without a token and 403 for the control token", async () => {
    const anonymous = await route(OAUTH_ROUTES.open, { method: "POST", body: "{}" });
    const control = await route(OAUTH_ROUTES.open, {
      method: "POST",
      body: "{}",
      token: CONTROL_TOKEN,
      user: CONTROL_USER,
    });

    expect(anonymous.status).toBe(407);
    expect(control.status).toBe(403);
    expect(JSON.parse(control.body).error.startsWith("pi-sandbox: ")).toBe(true);
    expect(state.proxy.opened).toEqual([]);
  });

  it("opens, relays the callback and cancels with the repository token", async () => {
    const port = await freePort();
    const opened = await route(OAUTH_ROUTES.open, {
      method: "POST",
      token: state.proxy.token,
      body: JSON.stringify({ url: authorizeUrl(port) }),
    });
    const { flow } = JSON.parse(opened.body) as { flow: string };
    const pending = await route(`${OAUTH_ROUTES.callback}?flow=${flow}`, { token: state.proxy.token });

    await hitCallback(port, "/callback?code=real-code-1&state=state-1");

    const ready = await route(`${OAUTH_ROUTES.callback}?flow=${flow}`, { token: state.proxy.token });
    const foreign = await route(`${OAUTH_ROUTES.callback}?flow=${flow}`, { token: state.proxy.otherToken });
    const cancelled = await route(`${OAUTH_ROUTES.cancel}?flow=${flow}`, {
      method: "POST",
      token: state.proxy.token,
    });
    const gone = await route(`${OAUTH_ROUTES.callback}?flow=${flow}`, { token: state.proxy.token });

    expect(opened.status).toBe(200);
    expect(pending).toMatchObject({ status: OAUTH_CALLBACK_STATUS.pending, body: "" });
    expect(ready.status).toBe(OAUTH_CALLBACK_STATUS.ready);
    expect(JSON.parse(ready.body)).toMatchObject({ status: "ready" });
    expect(ready.body).not.toContain("real-code-1");
    expect(foreign.status).toBe(404);
    expect(JSON.parse(cancelled.body)).toEqual({ ok: true });
    expect(gone.status).toBe(OAUTH_CALLBACK_STATUS.gone);
  });

  it("answers a bad open body with 400", async () => {
    const reply = await route(OAUTH_ROUTES.open, { method: "POST", token: state.proxy.token, body: "nope" });

    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body)).toEqual({
      ok: false,
      error: 'pi-sandbox: send {"url": "<authorization URL>"}',
    });
  });
});
