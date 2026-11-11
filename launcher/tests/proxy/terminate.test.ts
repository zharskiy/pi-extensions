import { createServer as createHttpsServer, type Server } from "node:https";
import type { Duplex } from "node:stream";
import { createSecureContext } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import { createDialer } from "../../proxy/dial.ts";
import type { SecretReply, SecretResolver } from "../../proxy/secrets/index.ts";
import type { LauncherCa } from "../../proxy/tls-ca.ts";
import {
  closeServer,
  createStateDir,
  fakeResolver,
  listen,
  openCa,
  portOf,
  removeDir,
  resolveTo,
  startTestProxy,
  type TestProxy,
  waitFor,
} from "./harness.ts";
import {
  openConnect,
  pageThrough,
  plainGet,
  readBody,
  readRest,
  requestThrough,
  secureTunnel,
} from "./proxy-client.ts";

const PLACEHOLDER = "pi-sandbox-0123456789abcdef01234567";

const API_PLACEHOLDER = "pi-sandbox-89abcdef0123456789abcdef";

const MISSING_PLACEHOLDER = "pi-sandbox-fedcba9876543210fedcba98";

const EXPIRED_PLACEHOLDER = "pi-sandbox-0f1e2d3c4b5a69788796a5b4";

const EXPIRED_LOGIN = "the provider-x login on the host is missing or expired";

const SECRET = "real-llm-secret";

const API_SECRET = "real-api-secret";

const GIT_SECRET = "real-git-secret";

const GH_PLACEHOLDER = "pi-sandbox-aaaabbbbccccddddeeeeffff";

const GH_SECRET = "gho_real-token";

const REPO = "1".repeat(64);

const RULES: CredentialRule[] = [
  {
    id: "llm",
    host: "llm.test",
    placeholder: PLACEHOLDER,
    header: "x-api-key",
    template: "{secret}",
    secret: { env: "LLM_KEY" },
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
    id: "expired",
    host: "api.test",
    pathPrefix: "/expired",
    placeholder: EXPIRED_PLACEHOLDER,
    secret: { piAuth: "provider-x", bearer: true },
  },
  {
    id: "git",
    host: "git.test",
    header: "authorization",
    template: "Basic {secret}",
    secret: { command: ["git-token"] },
  },
  {
    id: "broken",
    host: "broken.test",
    header: "x-api-key",
    template: "{secret}\r\nx-injected: 1",
    secret: { command: ["broken"] },
  },
  {
    id: "newline",
    host: "newline.test",
    header: "authorization",
    template: "Bearer {secret}",
    secret: { command: ["newline"] },
  },
  { id: "derived:gh", host: "npm.test", placeholder: GH_PLACEHOLDER, secret: { command: ["gh-token"] } },
];

const b64 = (text: string) => Buffer.from(text).toString("base64");

const state: {
  stateDir: string;
  ca: LauncherCa;
  upstream: Server;
  test: TestProxy;
  token: string;
  releaseStream: Array<() => void>;
  expiredSockets: Duplex[];
  seen: Array<{ url?: string; authorization?: string }>;
  resolver: ReturnType<typeof fakeResolver>;
} = {
  stateDir: "",
  ca: undefined as unknown as LauncherCa,
  upstream: undefined as unknown as Server,
  test: undefined as unknown as TestProxy,
  token: "",
  releaseStream: [],
  expiredSockets: [],
  seen: [],
  resolver: fakeResolver(
    {
      llm: SECRET,
      api: API_SECRET,
      git: GIT_SECRET,
      "derived:gh": GH_SECRET,
      broken: "value",
      newline: "trailing\n",
    },
    { expired: { ok: false, reason: EXPIRED_LOGIN, login: true } },
  ),
};

const respond = (
  request: { url?: string; headers: Record<string, unknown>; socket?: { destroy(): void } },
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

  if (request.url === "/cut") {
    response.writeHead(200, { "content-type": "text/plain" });

    response.write("partial");

    setTimeout(() => request.socket?.destroy(), 50);

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

  if (request.url === "/echo-auth") {
    response.writeHead(200, { "x-echo-authorization": String(request.headers.authorization) });

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
    "llm.test": await leafFor("llm.test"),
    "api.test": await leafFor("api.test"),
    "git.test": await leafFor("git.test"),
    "npm.test": await leafFor("npm.test"),
    "newline.test": await leafFor("newline.test"),
  };
  const server = createHttpsServer(
    {
      ...contexts["llm.test"],
      SNICallback: (name, callback) => {
        const leaf = contexts[name as keyof typeof contexts];

        callback(null, leaf === undefined ? undefined : createSecureContext(leaf));
      },
    },
    (request, response) => {
      if (request.url !== "/echo-body") {
        respond(request, response);

        return;
      }

      void readBody(request).then((body) => {
        response.writeHead(200, { "content-type": "application/json" });

        response.end(JSON.stringify({ method: request.method, headers: request.headers, body }));
      });
    },
  );

  server.on("upgrade", (request, socket: Duplex) => {
    if (request.url === "/socket-expired") {
      state.expiredSockets.push(socket);

      socket.resume();

      socket.write("HTTP/1.1 401 Unauthorized\r\ncontent-length: 2\r\n\r\n{}");

      return;
    }

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
    policy: {
      allow: ["api.test", "git.test", "npm.test", "broken.test", "newline.test"],
    },
    ca: state.ca,
    rules: RULES,
    resolver: state.resolver.resolver,
    ports: () => ({
      "llm.test:443": portOf(state.upstream),
      "api.test:443": portOf(state.upstream),
      "git.test:443": portOf(state.upstream),
      "npm.test:443": portOf(state.upstream),
      "broken.test:443": portOf(state.upstream),
      "newline.test:443": portOf(state.upstream),
    }),
  });
  state.token = state.test.token;
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

describe("a header rule with a placeholder", () => {
  it("replaces the placeholder and keeps the path", async () => {
    const body = await echoed("llm.test", "/v1/messages", { "x-api-key": PLACEHOLDER });

    expect(body).toMatchObject({ url: "/v1/messages", headers: { "x-api-key": SECRET } });
  });

  it("forwards any other value of the auth header untouched", async () => {
    const body = await echoed("llm.test", "/v1/messages", { "x-api-key": "user-supplied" });

    expect(body.headers["x-api-key"]).toBe("user-supplied");
  });

  it("streams server-sent events before the response ends", async () => {
    const response = await through("llm.test", "/v1/stream", { "x-api-key": PLACEHOLDER });
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
      "llm.test:443",
      "llm.test",
      state.ca.certPem,
      state.token,
    );

    secure.write(
      `GET /socket HTTP/1.1\r\nHost: llm.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nx-api-key: ${PLACEHOLDER}\r\n\r\n`,
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
    await waitFor(() =>
      state.test.log.find((entry) => entry.rule === "terminate" && entry.host === "llm.test"),
    );

    expect(JSON.stringify(state.test.log)).not.toContain(SECRET);
  });
});

describe("credential rules", () => {
  it("substitutes a placeholder inside auth-like headers and strips it from any other header", async () => {
    const body = await echoed("api.test", "/v1/models", {
      authorization: `Bearer ${API_PLACEHOLDER}`,
      "x-goog-api-key": API_PLACEHOLDER,
      "x-trace": API_PLACEHOLDER,
    });

    expect(body.headers.authorization).toBe(`Bearer ${API_SECRET}`);
    expect(body.headers["x-goog-api-key"]).toBe(API_SECRET);
    expect(body.headers["x-trace"]).toBeUndefined();
  });

  it("sets the header of a header rule when the client sends none", async () => {
    const body = await echoed("git.test", "/repo.git/info/refs");

    expect(body.headers.authorization).toBe(`Basic ${GIT_SECRET}`);
  });

  it("substitutes inside a Basic value git sends and scrubs the base64 it sent from the response", async () => {
    const sent = b64(`x-access-token:${GH_PLACEHOLDER}`);
    const body = await echoed("npm.test", "/repo.git/info/refs", { authorization: `Basic ${sent}` });

    expect(body.headers.authorization).toBe(`Basic ${b64(`x-access-token:${GH_SECRET}`)}`);

    const response = await through("npm.test", "/echo-auth", { authorization: `Basic ${sent}` });

    await readBody(response);

    expect(response.headers["x-echo-authorization"]).toBe(`Basic ${sent}`);
    expect(JSON.stringify(response.headers)).not.toContain(b64(`x-access-token:${GH_SECRET}`));
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

  it("strips the placeholder header when the secret is unavailable and records a denial", async () => {
    const body = await echoed("api.test", "/mcp/tools", { authorization: `Bearer ${MISSING_PLACEHOLDER}` });

    expect(body.headers.authorization).toBeUndefined();
    expect(state.test.log).toContainEqual(
      expect.objectContaining({
        host: "api.test",
        decision: "deny",
        rule: "credential",
        reason: "credential missing is unavailable: no secret for missing",
        repo: REPO,
      }),
    );
  });

  it("records a missing host login as a login denial naming the credential rule", async () => {
    const since = Date.now();
    const body = await echoed("api.test", "/expired/v1", { authorization: `Bearer ${EXPIRED_PLACEHOLDER}` });

    expect(body.headers.authorization).toBeUndefined();
    expect(state.test.log).toContainEqual(
      expect.objectContaining({ host: "api.test", decision: "deny", rule: "login", reason: EXPIRED_LOGIN }),
    );

    const reply = await plainGet(state.test.proxy.port, `/denials?since=${since}`, "127.0.0.1", state.token);

    expect(JSON.parse(reply.body).denials).toContainEqual(
      expect.objectContaining({ host: "api.test", port: 443, rule: "login", credentialRule: "expired" }),
    );
  });

  it("strips the placeholder of a host rule whose path prefix does not match", async () => {
    const body = await echoed("api.test", "/v1/models", {
      authorization: `Bearer ${API_PLACEHOLDER}`,
      "x-other-key": MISSING_PLACEHOLDER,
    });

    expect(body.headers.authorization).toBe(`Bearer ${API_SECRET}`);
    expect(body.headers["x-other-key"]).toBeUndefined();
  });

  it.each(["GET", "DELETE", "POST"])("keeps the framing of a chunked %s body", async (method) => {
    const raw = await rawExchange(
      "api.test:443",
      "api.test",
      [
        `${method} /echo-body HTTP/1.1`,
        "Host: api.test",
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        "5",
        "hello",
        "0",
        "",
        "",
      ].join("\r\n"),
    );
    const echo = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
      method: string;
      headers: Record<string, string>;
      body: string;
    };

    expect(echo).toMatchObject({ method, body: "hello", headers: { "transfer-encoding": "chunked" } });
  });

  it("ends the client response when the upstream dies in the middle of the body", async () => {
    const response = await through("api.test", "/cut", { authorization: `Bearer ${API_PLACEHOLDER}` });
    const outcome = await new Promise<string>((resolve) => {
      response.resume();

      response.once("end", () => resolve("end"));

      response.once("close", () => resolve(response.complete ? "end" : "aborted"));

      setTimeout(() => resolve("hang"), 3_000);
    });

    expect(outcome).toBe("aborted");
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

describe("a rule on a non-443 port", () => {
  const local: { test?: TestProxy; stateDir: string } = { stateDir: "" };

  beforeAll(async () => {
    local.stateDir = await createStateDir();
    local.test = await startTestProxy({
      stateDir: local.stateDir,
      policy: { allow: [] },
      ca: state.ca,
      rules: [{ ...RULES[0], port: 8443 } as CredentialRule],
      resolver: state.resolver.resolver,
      ports: () => ({ "llm.test:8443": portOf(state.upstream) }),
    });
  });

  afterAll(async () => {
    await local.test?.proxy.close();

    await removeDir(local.stateDir);
  });

  it("intercepts the host on the rule port and injects the credential", async () => {
    const response = await requestThrough({
      proxyPort: local.test?.proxy.port ?? 0,
      token: local.test?.token ?? "",
      host: "llm.test",
      port: 8443,
      ca: state.ca.certPem,
      path: "/messages",
      headers: { "x-api-key": PLACEHOLDER },
    });
    const body = JSON.parse(await readBody(response));

    expect(body).toMatchObject({ url: "/messages", headers: { "x-api-key": SECRET } });
  });

  it("refuses the host on 443", async () => {
    const page = await pageThrough(
      local.test?.proxy.port ?? 0,
      "llm.test:443",
      local.test?.token ?? "",
      state.ca.certPem,
    );

    expect(page).toMatchObject({ connect: 200, status: 403 });
    expect(page.body).toBe(
      "llm.test is not allowed by the sandbox. Ask the user to run pi sandbox egress allow llm.test on the host.",
    );
    expect(local.test?.log).toContainEqual(
      expect.objectContaining({ host: "llm.test", rule: "egress.allow" }),
    );
  });
});

const rawExchange = async (authority: string, servername: string, request: string) => {
  const secure = await secureTunnel(
    state.test.proxy.port,
    authority,
    servername,
    state.ca.certPem,
    state.token,
  );

  secure.write(request);

  return readRest(secure as never);
};

const rawGet = (host: string, target: string, headers: string[] = []) =>
  rawExchange(
    `${host}:443`,
    host,
    [`GET ${target} HTTP/1.1`, `Host: ${host}`, ...headers, "Connection: close", "", ""].join("\r\n"),
  );

const statusOf = (raw: string) => Number(raw.split(" ")[1]);

describe("request targets on a terminated host", () => {
  it("refuses an absolute-form target for another origin with 400 and sends nothing upstream", async () => {
    const before = state.seen.length;
    const raw = await rawGet("api.test", "https://attacker.example/x", [
      `Authorization: Bearer ${API_PLACEHOLDER}`,
    ]);

    expect(statusOf(raw)).toBe(400);
    expect(raw).not.toContain(API_SECRET);
    expect(state.seen.length).toBe(before);
  });

  it("rewrites an absolute-form target for the terminated host to origin form", async () => {
    const raw = await rawGet("api.test", "https://api.test/v1/models", [
      `Authorization: Bearer ${API_PLACEHOLDER}`,
    ]);

    expect(statusOf(raw)).toBe(200);
    expect(state.seen.at(-1)).toEqual({ url: "/v1/models", authorization: `Bearer ${API_SECRET}` });
  });

  it("refuses dot segments in the path", async () => {
    const before = state.seen.length;
    const raw = await Promise.all(
      ["/../admin", "/%2E%2e/admin", "/x/..%2fadmin"].map((target) =>
        rawGet("llm.test", target, [`x-api-key: ${PLACEHOLDER}`]),
      ),
    );

    expect(raw.map(statusOf)).toEqual([400, 400, 400]);
    expect(state.seen.length).toBe(before);
  });

  it("matches a rule path prefix on the decoded path", async () => {
    const body = await echoed("api.test", "/%6dcp/tools", { authorization: `Bearer ${MISSING_PLACEHOLDER}` });

    expect(body.headers.authorization).toBeUndefined();
  });

  it("answers a CONNECT with an uppercase name and a trailing dot like the plain name", async () => {
    const raw = await rawExchange(
      "API.Test.:443",
      "API.TEST",
      `GET /v1/models HTTP/1.1\r\nHost: api.test\r\nAuthorization: Bearer ${API_PLACEHOLDER}\r\nConnection: close\r\n\r\n`,
    );

    expect(statusOf(raw)).toBe(200);
    expect(state.seen.at(-1)).toEqual({ url: "/v1/models", authorization: `Bearer ${API_SECRET}` });
  });
});

describe("unusable credential values", () => {
  it("answers 502 when the outgoing request cannot be built and keeps serving", async () => {
    const raw = await rawGet("broken.test", "/x");
    const after = await echoed("api.test", "/v1/after", { authorization: `Bearer ${API_PLACEHOLDER}` });

    expect(statusOf(raw)).toBe(502);
    expect(raw).not.toContain("value");
    expect(after.headers.authorization).toBe(`Bearer ${API_SECRET}`);
  });

  it("treats a secret with a line break as unavailable", async () => {
    const body = await echoed("newline.test", "/x");

    expect(body.headers.authorization).toBeUndefined();
    expect(state.test.log).toContainEqual(
      expect.objectContaining({
        rule: "credential",
        decision: "deny",
        reason: "credential newline is unavailable: the secret holds a line break",
      }),
    );
  });
});

describe("an upstream certificate the proxy does not trust", () => {
  const local: { test?: TestProxy; stateDir: string } = { stateDir: "" };

  beforeAll(async () => {
    local.stateDir = await createStateDir();
    local.test = await startTestProxy({
      stateDir: local.stateDir,
      policy: { allow: ["api.test"] },
      ca: state.ca,
      upstreamCa: (await openCa(local.stateDir)).certPem,
      rules: RULES,
      resolver: state.resolver.resolver,
      ports: () => ({ "api.test:443": portOf(state.upstream) }),
    });
  }, 30_000);

  afterAll(async () => {
    await local.test?.proxy.close();

    await removeDir(local.stateDir);
  });

  it("answers 502 with the certificate error and names tls.extraCa", async () => {
    const response = await requestThrough({
      proxyPort: local.test?.proxy.port ?? 0,
      token: local.test?.token ?? "",
      host: "api.test",
      ca: state.ca.certPem,
      path: "/v1/models",
      headers: { authorization: `Bearer ${API_PLACEHOLDER}` },
    });
    const body = JSON.parse(await readBody(response)) as { error: string };

    expect(response.statusCode).toBe(502);
    expect(body.error).toMatch(
      /^upstream request failed: .*(certificate|issuer).*; if a proxy or CA on this network signs this host, set tls\.extraCa to its CA$/,
    );
    expect(local.test?.log).toContainEqual(
      expect.objectContaining({
        host: "api.test",
        decision: "deny",
        rule: "upstream",
        reason: expect.stringMatching(/(certificate|issuer).*tls\.extraCa/),
      }),
    );
  });
});

describe("terminated handshake", () => {
  it("closes a terminated CONNECT whose client never starts TLS", async () => {
    const reply = await openConnect(state.test.proxy.port, "git.test:443", state.token);
    const started = Date.now();

    await readRest(reply.socket);

    expect(reply.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(
      await waitFor(() => state.test.log.find((entry) => entry.rule === "sni" && entry.host === "git.test")),
    ).toMatchObject({ decision: "deny", reason: "no TLS server name" });
  });
});

describe("restricted addresses after DNS", () => {
  const local: { test?: TestProxy; stateDir: string; token: string } = { stateDir: "", token: "" };

  beforeAll(async () => {
    local.stateDir = await createStateDir();
    local.test = await startTestProxy({
      stateDir: local.stateDir,
      policy: { allow: ["api.test"] },
      ca: state.ca,
      rules: RULES,
      resolver: state.resolver.resolver,
      dial: createDialer({ resolve: resolveTo({ "api.test": "10.0.0.5" }) }),
    });
    local.token = local.test.token;
  });

  afterAll(async () => {
    await local.test?.proxy.close();

    await removeDir(local.stateDir);
  });

  it("refuses a terminated rule host that resolves to a private address before the tunnel opens", async () => {
    const reply = await openConnect(local.test?.proxy.port ?? 0, "api.test:443", local.token);
    const body = JSON.parse(await readRest(reply.socket)) as { rule: string; reason: string };

    expect(reply.status).toBe(403);
    expect(body).toMatchObject({
      rule: "private-address",
      reason: expect.stringContaining("restricted addresses"),
    });
    expect(local.test?.log).toContainEqual(
      expect.objectContaining({ host: "api.test", decision: "deny", rule: "private-address" }),
    );
  });
});

describe("a rule that answers with a sign-in reply", () => {
  const SIGN_IN: SecretReply = {
    status: 503,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: "finish the sign-in in the browser" }),
  };
  const local: { test?: TestProxy; stateDir: string; asked: string[] } = { stateDir: "", asked: [] };
  const resolver: SecretResolver = {
    resolve: async (key) => {
      local.asked.push(key);

      return key === "signin"
        ? { ok: false, reason: "not signed in", reply: SIGN_IN }
        : { ok: true, value: "key" };
    },
    invalidate: () => undefined,
    rejected: async () => SIGN_IN,
    close: async () => undefined,
  };

  beforeAll(async () => {
    local.stateDir = await createStateDir();
    local.test = await startTestProxy({
      stateDir: local.stateDir,
      policy: { allow: ["api.test"] },
      ca: state.ca,
      rules: [
        {
          id: "signin",
          host: "api.test",
          pathPrefix: "/mcp",
          placeholder: MISSING_PLACEHOLDER,
          secret: { env: "SIGN_IN" },
        },
        { id: "key", host: "api.test", header: "x-api-key", template: "{secret}", secret: { env: "KEY" } },
      ],
      resolver,
      ports: () => ({ "api.test:443": portOf(state.upstream) }),
    });
  }, 30_000);

  afterAll(async () => {
    await local.test?.proxy.close();

    await removeDir(local.stateDir);
  });

  const secure = () =>
    secureTunnel(
      local.test?.proxy.port ?? 0,
      "api.test:443",
      "api.test",
      state.ca.certPem,
      local.test?.token,
    );

  it("keeps the reply of the first rule when a later rule on the host resolves", async () => {
    local.asked.length = 0;

    const response = await requestThrough({
      proxyPort: local.test?.proxy.port ?? 0,
      token: local.test?.token,
      host: "api.test",
      ca: state.ca.certPem,
      path: "/mcp/tools",
      headers: { authorization: `Bearer ${MISSING_PLACEHOLDER}` },
    });

    expect(response.statusCode).toBe(503);
    expect(await readBody(response)).toBe(SIGN_IN.body);
    expect(local.asked).toEqual(["signin"]);
  });

  it("answers a rejected upgrade with the sign-in reply", async () => {
    const tunnel = await secure();

    tunnel.write(
      "GET /socket-expired HTTP/1.1\r\nHost: api.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );

    const raw = await readRest(tunnel as never);

    expect(raw.split("\r\n")[0]).toBe("HTTP/1.1 503 Service Unavailable");
    expect(raw).toContain(SIGN_IN.body);
    expect(
      await waitFor(() =>
        state.expiredSockets.every((socket) => socket.readableEnded || socket.destroyed) ? true : undefined,
      ),
    ).toBe(true);
  });
});
