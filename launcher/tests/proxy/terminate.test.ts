import { createServer as createHttpsServer, type Server } from "node:https";
import type { Duplex } from "node:stream";
import { createSecureContext } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import type { LauncherCa } from "../../proxy/tls-ca.ts";
import {
  closeServer,
  createStateDir,
  fakeResolver,
  listen,
  openCa,
  portOf,
  removeDir,
  startTestProxy,
  type TestProxy,
  waitFor,
} from "./harness.ts";
import {
  openConnect,
  pageThrough,
  readBody,
  readRest,
  requestThrough,
  secureTunnel,
} from "./proxy-client.ts";

const PLACEHOLDER = "pi-sandbox-0123456789abcdef01234567";

const API_PLACEHOLDER = "pi-sandbox-89abcdef0123456789abcdef";

const MISSING_PLACEHOLDER = "pi-sandbox-fedcba9876543210fedcba98";

const SECRET = "real-gateway-secret";

const API_SECRET = "real-api-secret";

const GIT_SECRET = "real-git-secret";

const REPO = "1".repeat(64);

const RULES: CredentialRule[] = [
  {
    id: "gateway",
    host: "gateway.test",
    placeholder: PLACEHOLDER,
    header: "x-api-key",
    template: "{secret}",
    secret: { env: "GATEWAY_KEY" },
  },
  { id: "api", host: "api.test", placeholder: API_PLACEHOLDER, secret: { piAuth: "api" } },
  {
    id: "missing",
    host: "api.test",
    pathPrefix: "/mcp",
    placeholder: MISSING_PLACEHOLDER,
    secret: { env: "NONE" },
  },
  {
    id: "git",
    host: "git.test",
    header: "authorization",
    template: "Basic {secret}",
    secret: { command: ["git-token"] },
  },
  {
    id: "derived:git",
    host: "npm.test",
    header: "authorization",
    template: "Basic {secret}",
    transform: "urlUserinfoBase64",
    secret: { command: ["git-url"] },
  },
];

const GIT_URL = "https://deploy%40corp:p%3Ass@npm.test/";

const GIT_BASIC = Buffer.from("deploy@corp:p:ss").toString("base64");

const state: {
  stateDir: string;
  ca: LauncherCa;
  upstream: Server;
  test: TestProxy;
  token: string;
  releaseStream: Array<() => void>;
  seen: Array<{ url?: string; authorization?: string }>;
  resolver: ReturnType<typeof fakeResolver>;
} = {
  stateDir: "",
  ca: undefined as unknown as LauncherCa,
  upstream: undefined as unknown as Server,
  test: undefined as unknown as TestProxy,
  token: "",
  releaseStream: [],
  seen: [],
  resolver: fakeResolver({ gateway: SECRET, api: API_SECRET, git: GIT_SECRET, "derived:git": GIT_URL }),
};

const respond = (
  request: { url?: string; headers: Record<string, unknown> },
  response: {
    writeHead(status: number, headers: Record<string, string | string[]>): void;
    write(chunk: string): void;
    end(body?: string): void;
  },
) => {
  state.seen.push({ url: request.url, authorization: request.headers.authorization as string | undefined });

  if (request.url === "/v1/stream") {
    response.writeHead(200, { "content-type": "text/event-stream" });

    response.write("data: first\n\n");

    state.releaseStream.push(() => response.end("data: last\n\n"));

    return;
  }

  if (request.url === "/leak") {
    response.writeHead(302, {
      location: `https://api.test/callback?token=${API_SECRET}`,
      "set-cookie": [`session=${API_SECRET}; Secure`],
      "www-authenticate": `Bearer error="${API_SECRET}"`,
    });

    response.end("{}");

    return;
  }

  if (request.url === "/expired") {
    response.writeHead(401, {});

    response.end("{}");

    return;
  }

  response.writeHead(200, { "content-type": "application/json" });

  response.end(JSON.stringify({ url: request.url, headers: request.headers }));
};

const startUpstream = async () => {
  const leafFor = async (host: string) => state.ca.leaf(host);
  const contexts = {
    "gateway.test": await leafFor("gateway.test"),
    "api.test": await leafFor("api.test"),
    "git.test": await leafFor("git.test"),
    "npm.test": await leafFor("npm.test"),
  };
  const server = createHttpsServer(
    {
      ...contexts["gateway.test"],
      SNICallback: (name, callback) => {
        const leaf = contexts[name as keyof typeof contexts];

        callback(null, leaf === undefined ? undefined : createSecureContext(leaf));
      },
    },
    respond,
  );

  server.on("upgrade", (request, socket: Duplex) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Key: ${request.headers["x-api-key"]}\r\n\r\n`,
    );

    socket.pipe(socket);
  });

  await listen(server);

  return server;
};

beforeAll(async () => {
  state.stateDir = await createStateDir();
  state.ca = await openCa(state.stateDir);
  state.upstream = await startUpstream();
  state.test = await startTestProxy({
    stateDir: state.stateDir,
    policy: { allow: ["api.test", "git.test", "npm.test"], mcpHosts: [], gatewayHost: "gateway.test" },
    ca: state.ca,
    rules: RULES,
    resolver: state.resolver.resolver,
    gateway: { host: "gateway.test", port: 443, url: "https://gateway.test/v1" },
    ports: () => ({
      "gateway.test:443": portOf(state.upstream),
      "api.test:443": portOf(state.upstream),
      "git.test:443": portOf(state.upstream),
      "npm.test:443": portOf(state.upstream),
    }),
  });
  state.token = await state.test.tokenOf(REPO);
}, 30_000);

afterAll(async () => {
  await state.test?.proxy.close();

  await closeServer(state.upstream);

  await removeDir(state.stateDir);
});

const through = (host: string, path: string, headers: Record<string, string> = {}) =>
  requestThrough({
    proxyPort: state.test.proxy.port,
    token: state.token,
    host,
    ca: state.ca.certPem,
    path,
    headers,
  });

const echoed = async (host: string, path: string, headers: Record<string, string> = {}) =>
  JSON.parse(await readBody(await through(host, path, headers))) as {
    url: string;
    headers: Record<string, string>;
  };

describe("legacy gateway rule", () => {
  it("replaces the placeholder and keeps the gateway path prefix", async () => {
    const body = await echoed("gateway.test", "/messages", { "x-api-key": PLACEHOLDER });

    expect(body).toMatchObject({ url: "/v1/messages", headers: { "x-api-key": SECRET } });
  });

  it("forwards any other value of the auth header untouched", async () => {
    const body = await echoed("gateway.test", "/messages", { "x-api-key": "user-supplied" });

    expect(body.headers["x-api-key"]).toBe("user-supplied");
  });

  it("streams server-sent events before the response ends", async () => {
    const response = await through("gateway.test", "/stream", { "x-api-key": PLACEHOLDER });
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
      state.test.proxy.port,
      "gateway.test:443",
      "gateway.test",
      state.ca.certPem,
      state.token,
    );

    secure.write(
      `GET /socket HTTP/1.1\r\nHost: gateway.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nx-api-key: ${PLACEHOLDER}\r\n\r\n`,
    );

    const head = await new Promise<string>((resolve) =>
      secure.once("data", (chunk: Buffer) => resolve(String(chunk))),
    );

    expect(head).toContain("101 Switching Protocols");
    expect(head).toContain(`X-Seen-Key: ${PLACEHOLDER}`);
    expect(head).not.toContain(SECRET);

    secure.write("ping");

    const reply = await new Promise<string>((resolve) =>
      secure.once("data", (chunk: Buffer) => resolve(String(chunk))),
    );

    expect(reply).toBe("ping");

    secure.destroy();
  });

  it("logs the terminated connection without the credential", async () => {
    await waitFor(() => state.test.log.find((entry) => entry.rule === "gateway"));

    expect(JSON.stringify(state.test.log)).not.toContain(SECRET);
  });
});

describe("credential rules", () => {
  it("substitutes a placeholder inside any auth-like header", async () => {
    const body = await echoed("api.test", "/v1/models", {
      authorization: `Bearer ${API_PLACEHOLDER}`,
      "x-goog-api-key": API_PLACEHOLDER,
      "x-trace": API_PLACEHOLDER,
    });

    expect(body.headers.authorization).toBe(`Bearer ${API_SECRET}`);
    expect(body.headers["x-goog-api-key"]).toBe(API_SECRET);
    expect(body.headers["x-trace"]).toBe(API_PLACEHOLDER);
  });

  it("sets the header of a header rule when the client sends none", async () => {
    const body = await echoed("git.test", "/repo.git/info/refs");

    expect(body.headers.authorization).toBe(`Basic ${GIT_SECRET}`);
  });

  it("sends the base64 userinfo of a URL secret, never the URL", async () => {
    const response = await through("npm.test", "/pkg");
    const body = JSON.parse(await readBody(response)) as { headers: Record<string, string> };

    expect(body.headers.authorization).toBe(`Basic ${GIT_BASIC}`);
    expect(JSON.stringify(body)).not.toContain(GIT_URL);
  });

  it("scrubs the secret from every response header and never shows it to the client", async () => {
    const secure = await secureTunnel(
      state.test.proxy.port,
      "api.test:443",
      "api.test",
      state.ca.certPem,
      state.token,
    );

    secure.write(
      `GET /leak HTTP/1.1\r\nHost: api.test\r\nAuthorization: Bearer ${API_PLACEHOLDER}\r\nConnection: close\r\n\r\n`,
    );

    const raw = await readRest(secure as never);

    expect(raw).toContain(`location: https://api.test/callback?token=${API_PLACEHOLDER}`);
    expect(raw).toContain(`session=${API_PLACEHOLDER}`);
    expect(raw).not.toContain(API_SECRET);
    expect(state.seen).toContainEqual({ url: "/leak", authorization: `Bearer ${API_SECRET}` });
  });

  it("strips the placeholder header when the secret is unavailable and logs it", async () => {
    const body = await echoed("api.test", "/mcp/tools", { authorization: `Bearer ${MISSING_PLACEHOLDER}` });

    expect(body.headers.authorization).toBeUndefined();
    expect(state.test.log).toContainEqual(
      expect.objectContaining({
        rule: "credential",
        reason: "unavailable",
        credential: "missing",
        repo: REPO,
      }),
    );
  });

  it("asks for a fresh secret after the upstream answers 401", async () => {
    const response = await through("api.test", "/expired", { authorization: `Bearer ${API_PLACEHOLDER}` });

    await readBody(response);

    expect(response.statusCode).toBe(401);
    expect(state.resolver.invalidated).toContain("api");
  });

  it("refuses a TLS server name that differs from the CONNECT host", async () => {
    const outcome = await secureTunnel(
      state.test.proxy.port,
      "api.test:443",
      "git.test",
      state.ca.certPem,
      state.token,
    ).then(
      () => "connected",
      () => "refused",
    );

    expect(outcome).toBe("refused");
    expect(
      await waitFor(() => state.test.log.find((entry) => entry.rule === "sni" && entry.host === "api.test")),
    ).toMatchObject({ decision: "deny", sni: "git.test" });
  });

  it("does not terminate for a client without a repository token", async () => {
    const reply = await openConnect(state.test.proxy.port, "api.test:443");

    await readRest(reply.socket);

    expect(reply.status).toBe(407);
  });
});

describe("gateway on a non-443 port", () => {
  const local: { test?: TestProxy; stateDir: string } = { stateDir: "" };

  beforeAll(async () => {
    local.stateDir = await createStateDir();
    local.test = await startTestProxy({
      stateDir: local.stateDir,
      policy: { allow: [], mcpHosts: [], gatewayHost: "gateway.test", gatewayPort: 8443 },
      ca: state.ca,
      rules: [{ ...RULES[0], port: 8443 } as CredentialRule],
      resolver: state.resolver.resolver,
      gateway: { host: "gateway.test", port: 8443, url: "https://gateway.test:8443/v1" },
      ports: () => ({ "gateway.test:8443": portOf(state.upstream) }),
    });
  });

  afterAll(async () => {
    await local.test?.proxy.close();

    await removeDir(local.stateDir);
  });

  it("intercepts the gateway on the URL port and injects the credential", async () => {
    const response = await requestThrough({
      proxyPort: local.test?.proxy.port ?? 0,
      token: (await local.test?.tokenOf(REPO)) ?? "",
      host: "gateway.test",
      port: 8443,
      ca: state.ca.certPem,
      path: "/messages",
      headers: { "x-api-key": PLACEHOLDER },
    });
    const body = JSON.parse(await readBody(response));

    expect(body).toMatchObject({ url: "/v1/messages", headers: { "x-api-key": SECRET } });
  });

  it("refuses the gateway host on 443", async () => {
    const page = await pageThrough(
      local.test?.proxy.port ?? 0,
      "gateway.test:443",
      (await local.test?.tokenOf(REPO)) ?? "",
      state.ca.certPem,
    );

    expect(page).toMatchObject({ connect: 200, status: 403 });
    expect(page.body).toBe(
      "pi-sandbox: gateway.test is not allowed; run pi sandbox egress allow gateway.test",
    );
    expect(local.test?.log).toContainEqual(
      expect.objectContaining({ host: "gateway.test", rule: "egress.port" }),
    );
  });
});
