import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpsServer, type Server } from "node:https";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessLogEntry } from "../../proxy/access-log.ts";
import { type ProxyServer, startProxyServer } from "../../proxy/server.ts";
import { type LauncherCa, openLauncherCa } from "../../proxy/tls-ca.ts";
import { createProcessRunner } from "../../shared/index.ts";
import { openConnect, plainGet, readBody, readRest, requestThrough, secureTunnel } from "./proxy-client.ts";

const PLACEHOLDER = "pi-sandbox-placeholder";

const SECRET = "real-secret-credential";

const TOKEN = "proxy-token-for-tests";

const state: {
  stateDir: string;
  ca: LauncherCa;
  target: Server;
  gateway: Server;
  proxy: ProxyServer;
  log: AccessLogEntry[];
  releaseStream: Array<() => void>;
} = {
  stateDir: "",
  ca: undefined as unknown as LauncherCa,
  target: undefined as unknown as Server,
  gateway: undefined as unknown as Server,
  proxy: undefined as unknown as ProxyServer,
  log: [],
  releaseStream: [],
};

const portOf = (server: Server) => (server.address() as AddressInfo).port;

const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const echoHeaders =
  (name: string) => (request: { headers: unknown; url?: string }, response: { end(body: string): void }) =>
    response.end(JSON.stringify({ server: name, url: request.url, headers: request.headers }));

const startGateway = async () => {
  const gateway = createHttpsServer(await state.ca.leaf("gateway.test"), (request, response) => {
    if (request.url === "/v1/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });

      response.write("data: first\n\n");

      state.releaseStream.push(() => response.end("data: last\n\n"));

      return;
    }

    echoHeaders("gateway")(request, response);
  });

  gateway.on("upgrade", (request, socket: Duplex) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Key: ${request.headers["x-api-key"]}\r\n\r\n`,
    );

    socket.pipe(socket);
  });

  await listen(gateway);

  return gateway;
};

const dialMap = () => {
  const ports: Record<string, number> = {
    "target.test:443": portOf(state.target),
    "other.test:443": portOf(state.target),
    "gateway.test:443": portOf(state.gateway),
  };

  return (host: string, port: number) => connect({ host: "127.0.0.1", port: ports[`${host}:${port}`] ?? 1 });
};

beforeAll(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-proxy-"));
  state.ca = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });
  state.target = createHttpsServer(await state.ca.leaf("target.test"), echoHeaders("target"));

  await listen(state.target);

  state.gateway = await startGateway();
  state.proxy = await startProxyServer({
    listen: { host: "127.0.0.1", port: 0 },
    policy: { allow: ["target.test", "other.test"], mcpHosts: [], gatewayHost: "gateway.test" },
    token: TOKEN,
    gateway: {
      host: "gateway.test",
      url: "https://gateway.test/v1",
      authHeader: "x-api-key",
      placeholder: PLACEHOLDER,
      credentials: { token: async () => SECRET },
    },
    ca: state.ca,
    log: (entry) => state.log.push(entry),
    dial: dialMap(),
    upstreamCa: state.ca.certPem,
    helloTimeoutMs: 500,
  });
}, 30_000);

afterAll(async () => {
  await state.proxy?.close();

  state.target?.close();

  state.gateway?.close();

  await rm(state.stateDir, { recursive: true, force: true });
});

const waitForLog = async (match: (entry: AccessLogEntry) => boolean): Promise<AccessLogEntry> => {
  const found = state.log.find(match);

  if (found !== undefined) {
    return found;
  }

  await new Promise((resolve) => setTimeout(resolve, 20));

  return waitForLog(match);
};

describe("proxy authentication", () => {
  it("answers a CONNECT without credentials with 407 and a challenge, and never dials", async () => {
    const reply = await openConnect(state.proxy.port, "target.test:443");
    const body = JSON.parse(await readRest(reply.socket));

    expect(reply.status).toBe(407);
    expect(reply.head).toContain('Proxy-Authenticate: Basic realm="pi-sandbox"');
    expect(body).toEqual({ error: "missing or wrong Proxy-Authorization" });
    expect(state.log).toContainEqual(
      expect.objectContaining({ host: "target.test", decision: "deny", rule: "auth" }),
    );
  });

  it("answers a CONNECT with a wrong token with 407", async () => {
    const reply = await openConnect(state.proxy.port, "target.test:443", "not-the-token");

    await readRest(reply.socket);

    expect(reply.status).toBe(407);
  });

  it("answers plain requests without credentials with 407, health included", async () => {
    const health = await plainGet(state.proxy.port, "/healthz");

    expect(health.status).toBe(407);
    expect(health.headers["proxy-authenticate"]).toBe('Basic realm="pi-sandbox"');
  });

  it("does not inject the gateway credential for an unauthenticated client", async () => {
    const outcome = await secureTunnel(
      state.proxy.port,
      "gateway.test:443",
      "gateway.test",
      state.ca.certPem,
    ).then(
      () => "connected",
      () => "refused",
    );

    expect(outcome).toBe("refused");
  });

  it("never writes the proxy token to the access log", async () => {
    const reply = await openConnect(state.proxy.port, "evil.test:443", TOKEN);

    await readRest(reply.socket);

    expect(JSON.stringify(state.log)).not.toContain(TOKEN);
  });

  it("logs an unparseable CONNECT authority as unparseable, never the raw request target", async () => {
    const raw = "leaked-secret-value/path?q=1";
    const unauthenticated = await openConnect(state.proxy.port, raw);

    await readRest(unauthenticated.socket);

    const authenticated = await openConnect(state.proxy.port, raw, TOKEN);

    await readRest(authenticated.socket);

    expect(JSON.stringify(state.log)).not.toContain("leaked-secret-value");
    expect(state.log).toContainEqual(expect.objectContaining({ host: "unparseable", rule: "auth" }));
    expect(state.log).toContainEqual(expect.objectContaining({ host: "unparseable", rule: "connect" }));
  });
});

describe("CONNECT tunnel", () => {
  it("tunnels an allowed host end to end without decrypting it", async () => {
    const response = await requestThrough({
      proxyPort: state.proxy.port,
      token: TOKEN,
      host: "target.test",
      ca: state.ca.certPem,
      path: "/hello",
      headers: { "x-api-key": PLACEHOLDER },
    });
    const body = JSON.parse(await readBody(response));

    expect(body).toMatchObject({ server: "target", url: "/hello", headers: { "x-api-key": PLACEHOLDER } });
  });

  it("logs the tunnel with byte counts once it closes", async () => {
    const secure = await secureTunnel(
      state.proxy.port,
      "target.test:443",
      "target.test",
      state.ca.certPem,
      TOKEN,
    );

    secure.end("GET / HTTP/1.1\r\nHost: target.test\r\nConnection: close\r\n\r\n");

    await readRest(secure as never);

    const entry = await waitForLog(
      (item) => item.decision === "allow" && item.bytesIn > 0 && item.sni === "target.test",
    );

    expect(entry).toMatchObject({ host: "target.test", rule: "egress.allow" });

    expect(entry.bytesOut).toBeGreaterThan(0);
  });

  it("answers a host outside the allowlist with a 403 and the rule", async () => {
    const reply = await openConnect(state.proxy.port, "evil.test:443", TOKEN);
    const body = JSON.parse(await readRest(reply.socket));

    expect(reply.status).toBe(403);

    expect(reply.head).toContain("Proxy-Agent: pi-sandbox");

    expect(body).toMatchObject({ denied: "evil.test", rule: "egress.allow" });

    expect(state.log).toContainEqual(
      expect.objectContaining({ host: "evil.test", decision: "deny", rule: "egress.allow" }),
    );
  });

  it.each([
    ["93.184.216.34:443", "ip-literal"],
    ["169.254.169.254:443", "metadata"],
    ["127.0.0.1:443", "loopback"],
    ["[::1]:443", "loopback"],
    ["localhost:443", "loopback"],
  ])("denies %s with rule %s", async (authority, rule) => {
    const reply = await openConnect(state.proxy.port, authority, TOKEN);
    const body = JSON.parse(await readRest(reply.socket));

    expect(reply.status).toBe(403);

    expect(body.rule).toBe(rule);
  });

  it("closes the tunnel when the TLS server name differs from the CONNECT host", async () => {
    const outcome = await secureTunnel(
      state.proxy.port,
      "target.test:443",
      "other.test",
      state.ca.certPem,
      TOKEN,
    ).then(
      () => "connected",
      () => "closed",
    );

    expect(outcome).toBe("closed");

    expect(await waitForLog((entry) => entry.rule === "sni" && entry.host === "target.test")).toMatchObject({
      decision: "deny",
      sni: "other.test",
    });
  });

  it("closes a tunnel that does not start with a TLS ClientHello", async () => {
    const reply = await openConnect(state.proxy.port, "target.test:443", TOKEN);

    reply.socket.write("GET / HTTP/1.1\r\nHost: target.test\r\n\r\n");

    expect(await readRest(reply.socket)).toBe("");
  });
});

describe("gateway interception", () => {
  it("replaces the placeholder credential", async () => {
    const response = await requestThrough({
      proxyPort: state.proxy.port,
      token: TOKEN,
      host: "gateway.test",
      ca: state.ca.certPem,
      path: "/messages",
      headers: { "x-api-key": PLACEHOLDER },
    });
    const body = JSON.parse(await readBody(response));

    expect(body).toMatchObject({ server: "gateway", url: "/v1/messages", headers: { "x-api-key": SECRET } });
  });

  it("forwards any other value of the auth header untouched", async () => {
    const response = await requestThrough({
      proxyPort: state.proxy.port,
      token: TOKEN,
      host: "gateway.test",
      ca: state.ca.certPem,
      path: "/messages",
      headers: { "x-api-key": "user-supplied" },
    });
    const body = JSON.parse(await readBody(response));

    expect(body.headers["x-api-key"]).toBe("user-supplied");
  });

  it("streams server-sent events before the response ends", async () => {
    const response = await requestThrough({
      proxyPort: state.proxy.port,
      token: TOKEN,
      host: "gateway.test",
      ca: state.ca.certPem,
      path: "/stream",
      headers: { "x-api-key": PLACEHOLDER },
    });
    const first = await new Promise<string>((resolve) =>
      response.once("data", (chunk: Buffer) => resolve(String(chunk))),
    );

    expect(first).toBe("data: first\n\n");

    state.releaseStream.forEach((release) => {
      release();
    });

    expect(await readBody(response)).toBe("data: last\n\n");
  });

  it("forwards a WebSocket upgrade with the credential", async () => {
    const secure = await secureTunnel(
      state.proxy.port,
      "gateway.test:443",
      "gateway.test",
      state.ca.certPem,
      TOKEN,
    );

    secure.write(
      `GET /socket HTTP/1.1\r\nHost: gateway.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nx-api-key: ${PLACEHOLDER}\r\n\r\n`,
    );

    const head = await new Promise<string>((resolve) =>
      secure.once("data", (chunk: Buffer) => resolve(String(chunk))),
    );

    expect(head).toContain("101 Switching Protocols");

    expect(head).toContain(`X-Seen-Key: ${SECRET}`);

    secure.write("ping");

    const echoed = await new Promise<string>((resolve) =>
      secure.once("data", (chunk: Buffer) => resolve(String(chunk))),
    );

    expect(echoed).toBe("ping");

    secure.destroy();
  });

  it("never writes the credential to the access log", async () => {
    await waitForLog((entry) => entry.rule === "gateway");

    expect(JSON.stringify(state.log)).not.toContain(SECRET);
  });
});

describe("gateway on a non-443 port", () => {
  const local: { proxy?: ProxyServer } = {};

  beforeAll(async () => {
    local.proxy = await startProxyServer({
      listen: { host: "127.0.0.1", port: 0 },
      policy: { allow: [], mcpHosts: [], gatewayHost: "gateway.test", gatewayPort: 8443 },
      token: TOKEN,
      gateway: {
        host: "gateway.test",
        url: "https://gateway.test:8443/v1",
        authHeader: "x-api-key",
        placeholder: PLACEHOLDER,
        credentials: { token: async () => SECRET },
      },
      ca: state.ca,
      log: () => undefined,
      dial: (host, port) =>
        connect({
          host: "127.0.0.1",
          port: `${host}:${port}` === "gateway.test:8443" ? portOf(state.gateway) : 1,
        }),
      upstreamCa: state.ca.certPem,
    });
  });

  afterAll(async () => {
    await local.proxy?.close();
  });

  it("intercepts the gateway on the URL port and injects the credential", async () => {
    const response = await requestThrough({
      proxyPort: local.proxy?.port ?? 0,
      token: TOKEN,
      host: "gateway.test",
      port: 8443,
      ca: state.ca.certPem,
      path: "/messages",
      headers: { "x-api-key": PLACEHOLDER },
    });
    const body = JSON.parse(await readBody(response));

    expect(body).toMatchObject({ server: "gateway", url: "/v1/messages", headers: { "x-api-key": SECRET } });
  });

  it("refuses the gateway host on 443", async () => {
    const reply = await openConnect(local.proxy?.port ?? 0, "gateway.test:443", TOKEN);

    expect(reply.status).toBe(403);

    expect(JSON.parse(await readRest(reply.socket)).rule).toBe("egress.port");
  });
});

describe("plain HTTP", () => {
  it("serves health with the policy hash", async () => {
    const health = await plainGet(state.proxy.port, "/healthz", "127.0.0.1", TOKEN);

    expect(health.status).toBe(200);

    expect(JSON.parse(health.body)).toMatchObject({ ok: true, policyHash: state.proxy.policyHash });
  });

  it("serves the policy", async () => {
    const policy = JSON.parse((await plainGet(state.proxy.port, "/policy", "127.0.0.1", TOKEN)).body);

    expect(policy).toMatchObject({ allow: ["target.test", "other.test"], gatewayHost: "gateway.test" });
  });

  it("denies proxied plain HTTP requests", async () => {
    const denied = await plainGet(state.proxy.port, "http://target.test/", "target.test", TOKEN);

    expect(denied.status).toBe(403);

    expect(denied.headers["proxy-agent"]).toBe("pi-sandbox");

    expect(JSON.parse(denied.body)).toMatchObject({ denied: "target.test", rule: "plain-http" });
  });
});
