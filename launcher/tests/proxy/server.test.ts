import { writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server } from "node:https";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addGrant, endSession, newLaunchId, registerSession } from "../../grants/index.ts";
import { writeProxyDynamic } from "../../proxy/dynamic.ts";
import type { LauncherCa } from "../../proxy/tls-ca.ts";
import { stateLayout } from "../../shared/index.ts";
import {
  CONTROL_TOKEN,
  closeServer,
  createStateDir,
  listen,
  openCa,
  POLICY_HASH,
  portOf,
  removeDir,
  startTestProxy,
  type TestProxy,
  waitFor,
} from "./harness.ts";
import {
  CONTROL_USER,
  openConnect,
  plainGet,
  plainRequest,
  readBody,
  readRest,
  requestThrough,
  secureTunnel,
} from "./proxy-client.ts";

const REPO = "1".repeat(64);

const OTHER_REPO = "2".repeat(64);

const LIMITS = { enabled: true, maxHours: 168, permanent: true };

const state: {
  stateDir: string;
  ca: LauncherCa;
  target: Server;
  test: TestProxy;
  token: string;
  otherToken: string;
  controlMessages: unknown[];
} = {
  stateDir: "",
  ca: undefined as unknown as LauncherCa,
  target: undefined as unknown as Server,
  test: undefined as unknown as TestProxy,
  token: "",
  otherToken: "",
  controlMessages: [],
};

const ports = () => {
  const target = portOf(state.target);

  return {
    "target.test:443": target,
    "other.test:443": target,
    "granted.test:443": target,
    "derived.test:443": target,
    "reloaded.test:443": target,
  };
};

const hint = (host: string) => `pi-sandbox: ${host} is not allowed; run pi sandbox egress allow ${host}`;

beforeAll(async () => {
  state.stateDir = await createStateDir();
  state.ca = await openCa(state.stateDir);
  state.target = createHttpsServer(await state.ca.leaf("target.test"), (request, response) =>
    response.end(JSON.stringify({ url: request.url, headers: request.headers })),
  );

  await listen(state.target);

  state.test = await startTestProxy({
    stateDir: state.stateDir,
    policy: { allow: ["target.test", "other.test"], mcpHosts: [], deny: ["blocked.test"] },
    ca: state.ca,
    ports,
    onControl: (message) => {
      state.controlMessages.push(message);

      return { ok: true };
    },
  });
  state.token = await state.test.tokenOf(REPO);
  state.otherToken = await state.test.tokenOf(OTHER_REPO);
}, 30_000);

afterAll(async () => {
  await state.test?.proxy.close();

  await closeServer(state.target);

  await removeDir(state.stateDir);
});

const connectStatus = async (authority: string, token = state.token) => {
  const reply = await openConnect(state.test.proxy.port, authority, token);

  if (reply.status === 200) {
    reply.socket.destroy();

    return { status: 200, body: undefined, head: reply.head };
  }

  return { status: reply.status, body: JSON.parse(await readRest(reply.socket)), head: reply.head };
};

describe("proxy authentication", () => {
  it("answers a CONNECT without credentials with 407 and a challenge", async () => {
    const reply = await openConnect(state.test.proxy.port, "target.test:443");
    const body = JSON.parse(await readRest(reply.socket));

    expect(reply.status).toBe(407);
    expect(reply.head).toContain('Proxy-Authenticate: Basic realm="pi-sandbox"');
    expect(body).toEqual({ error: "missing or wrong Proxy-Authorization" });
  });

  it("answers a CONNECT with an unknown token with 407", async () => {
    expect((await connectStatus("target.test:443", "not-a-token")).status).toBe(407);
  });

  it("never lets the control token open a tunnel", async () => {
    const reply = await openConnect(state.test.proxy.port, "target.test:443", CONTROL_TOKEN, CONTROL_USER);

    await readRest(reply.socket);

    expect(reply.status).toBe(407);
  });

  it("answers plain requests without credentials with 407, health included", async () => {
    const health = await plainGet(state.test.proxy.port, "/healthz");

    expect(health.status).toBe(407);
    expect(health.headers["proxy-authenticate"]).toBe('Basic realm="pi-sandbox"');
  });

  it("serves health to the control token and to a repository token", async () => {
    const control = await plainGet(
      state.test.proxy.port,
      "/healthz",
      "127.0.0.1",
      CONTROL_TOKEN,
      CONTROL_USER,
    );
    const repo = await plainGet(state.test.proxy.port, "/healthz", "127.0.0.1", state.token);

    expect(JSON.parse(control.body)).toMatchObject({ ok: true, policyHash: POLICY_HASH });
    expect(repo.status).toBe(200);
  });

  it("never writes a token to the access log", async () => {
    await connectStatus("evil.test:443");

    expect(JSON.stringify(state.test.log)).not.toContain(state.token);
  });

  it("logs an unparseable CONNECT authority as unparseable", async () => {
    const raw = "leaked-secret-value/path?q=1";

    await connectStatus(raw, "nope");

    await connectStatus(raw);

    expect(JSON.stringify(state.test.log)).not.toContain("leaked-secret-value");
    expect(state.test.log).toContainEqual(expect.objectContaining({ host: "unparseable", rule: "connect" }));
  });
});

describe("per-repository tokens", () => {
  it("tags log entries with the repository of the token", async () => {
    await connectStatus("evil.test:443", state.otherToken);

    expect(state.test.log).toContainEqual(
      expect.objectContaining({ repo: OTHER_REPO, host: "evil.test", decision: "deny" }),
    );
  });

  it("accepts a repository token created after the proxy started", async () => {
    const late = await state.test.tokenOf("3".repeat(64));

    expect((await connectStatus("target.test:443", late)).status).toBe(200);
  });
});

describe("control messages", () => {
  it("accepts env secrets from the control token only", async () => {
    const body = JSON.stringify({ type: "env-secrets", secrets: { rule: "value" } });
    const refused = await plainRequest(state.test.proxy.port, "/control", {
      method: "POST",
      token: state.token,
      body,
    });
    const accepted = await plainRequest(state.test.proxy.port, "/control", {
      method: "POST",
      token: CONTROL_TOKEN,
      user: CONTROL_USER,
      body,
    });

    expect(refused.status).toBe(407);
    expect(JSON.parse(accepted.body)).toEqual({ ok: true });
    expect(state.controlMessages).toEqual([{ type: "env-secrets", secrets: { rule: "value" } }]);
  });

  it("refuses an unknown control message", async () => {
    const reply = await plainRequest(state.test.proxy.port, "/control", {
      method: "POST",
      token: CONTROL_TOKEN,
      user: CONTROL_USER,
      body: JSON.stringify({ type: "other" }),
    });

    expect(reply.status).toBe(400);
  });
});

describe("CONNECT tunnel", () => {
  it("tunnels an allowed host end to end without decrypting it", async () => {
    const response = await requestThrough({
      proxyPort: state.test.proxy.port,
      token: state.token,
      host: "target.test",
      ca: state.ca.certPem,
      path: "/hello",
      headers: { authorization: "Bearer pi-sandbox-000000000000000000000000" },
    });
    const body = JSON.parse(await readBody(response));

    expect(body).toMatchObject({
      url: "/hello",
      headers: { authorization: "Bearer pi-sandbox-000000000000000000000000" },
    });
  });

  it("logs the tunnel with byte counts once it closes", async () => {
    const secure = await secureTunnel(
      state.test.proxy.port,
      "target.test:443",
      "target.test",
      state.ca.certPem,
      state.token,
    );

    secure.end("GET / HTTP/1.1\r\nHost: target.test\r\nConnection: close\r\n\r\n");

    await readRest(secure as never);

    const entry = await waitFor(() =>
      state.test.log.find(
        (item) => item.decision === "allow" && item.bytesIn > 0 && item.sni === "target.test",
      ),
    );

    expect(entry).toMatchObject({ host: "target.test", rule: "egress.allow", repo: REPO });
  });

  it("denies a host outside the allowlist with the allow hint in the status line and body", async () => {
    const denied = await connectStatus("evil.test:443");

    expect(denied.status).toBe(403);
    expect(denied.head.split("\r\n")[0]).toBe(`HTTP/1.1 403 ${hint("evil.test")}`);
    expect(denied.body).toEqual({ denied: "evil.test", rule: "egress.allow", reason: hint("evil.test") });
  });

  it("names the port in the hint for a port that is not allowed", async () => {
    const denied = await connectStatus("target.test:8443");

    expect(denied.body).toMatchObject({ rule: "egress.port", reason: hint("target.test:8443") });
  });

  it.each([
    ["93.184.216.34:443", "ip-literal"],
    ["169.254.169.254:443", "metadata"],
    ["127.0.0.1:443", "loopback"],
    ["[::1]:443", "loopback"],
    ["localhost:443", "loopback"],
    ["blocked.test:443", "egress.deny"],
  ])("denies %s with rule %s", async (authority, rule) => {
    const denied = await connectStatus(authority);

    expect(denied.status).toBe(403);
    expect(denied.body.rule).toBe(rule);
  });

  it("closes the tunnel when the TLS server name differs from the CONNECT host", async () => {
    const outcome = await secureTunnel(
      state.test.proxy.port,
      "target.test:443",
      "other.test",
      state.ca.certPem,
      state.token,
    ).then(
      () => "connected",
      () => "closed",
    );

    expect(outcome).toBe("closed");
    expect(
      await waitFor(() => state.test.log.find((entry) => entry.rule === "sni" && entry.sni === "other.test")),
    ).toMatchObject({ decision: "deny", host: "target.test" });
  });

  it("closes a tunnel that does not start with a TLS ClientHello", async () => {
    const reply = await openConnect(state.test.proxy.port, "target.test:443", state.token);

    reply.socket.write("GET / HTTP/1.1\r\nHost: target.test\r\n\r\n");

    expect(await readRest(reply.socket)).toBe("");
  });
});

describe("grants", () => {
  it("allows a host with a repository grant for that repository only", async () => {
    await addGrant(
      state.stateDir,
      { host: "granted.test", port: 443, repoHash: REPO, scope: { kind: "permanent" } },
      LIMITS,
      Date.now(),
    );

    expect((await connectStatus("granted.test:443")).status).toBe(200);
    expect((await connectStatus("granted.test:443", state.otherToken)).status).toBe(403);
  });

  it("keeps egress.deny above a grant", async () => {
    await addGrant(
      state.stateDir,
      { host: "blocked.test", port: 443, scope: { kind: "permanent" } },
      LIMITS,
      Date.now(),
    );

    expect((await connectStatus("blocked.test:443")).body.rule).toBe("egress.deny");
  });

  it("keeps private addresses denied with a grant", async () => {
    await addGrant(
      state.stateDir,
      { host: "10.0.0.1", port: 443, scope: { kind: "permanent" } },
      LIMITS,
      Date.now(),
    );

    expect((await connectStatus("10.0.0.1:443")).body.rule).toBe("private-address");
  });

  it("allows a session grant only while its launch is live", async () => {
    const launchId = newLaunchId();

    await registerSession(state.stateDir, {
      launchId,
      pid: process.pid,
      repoHash: OTHER_REPO,
      startedAt: Date.now(),
    });

    await addGrant(
      state.stateDir,
      { host: "granted.test", port: 443, repoHash: OTHER_REPO, scope: { kind: "session", launchId } },
      LIMITS,
      Date.now(),
    );

    expect((await connectStatus("granted.test:443", state.otherToken)).status).toBe(200);

    await endSession(state.stateDir, { repoHash: OTHER_REPO, launchId, onLast: async () => undefined });

    expect((await connectStatus("granted.test:443", state.otherToken)).status).toBe(403);
  });
});

describe("dynamic configuration", () => {
  it("picks up derived hosts written after the proxy started", async () => {
    expect((await connectStatus("reloaded.test:443")).status).toBe(403);

    await writeProxyDynamic(state.stateDir, POLICY_HASH, {
      version: 1,
      rules: [],
      derivedHosts: ["reloaded.test"],
      tokens: {},
    });

    expect((await connectStatus("reloaded.test:443")).status).toBe(200);
  });

  it("keeps a broken dynamic file from widening anything", async () => {
    await writeFile(stateLayout(state.stateDir).proxyDynamic(POLICY_HASH), "{ not json");

    expect((await connectStatus("reloaded.test:443")).status).toBe(403);
  });
});

describe("denials", () => {
  it("serves the recent denials of the token's repository only", async () => {
    const since = Date.now();

    await connectStatus("denied-here.test:443");

    await connectStatus("denied-there.test:443", state.otherToken);

    const reply = await plainGet(state.test.proxy.port, `/denials?since=${since}`, "127.0.0.1", state.token);
    const hosts = JSON.parse(reply.body).denials.map((entry: { host: string }) => entry.host);

    expect(hosts).toContain("denied-here.test");
    expect(hosts).not.toContain("denied-there.test");
    expect(JSON.parse(reply.body).denials).toContainEqual(
      expect.objectContaining({ host: "denied-here.test", port: 443, repoHash: REPO, rule: "egress.allow" }),
    );
  });

  it("keeps the last 200 denials per repository", async () => {
    await Array.from({ length: 210 }, (_, index) => `many-${index}.test:443`).reduce(
      async (previous, authority) => {
        await previous;

        await connectStatus(authority);
      },
      Promise.resolve(),
    );

    const reply = await plainGet(state.test.proxy.port, "/denials?since=0", "127.0.0.1", state.token);

    expect(JSON.parse(reply.body).denials).toHaveLength(200);
  });
});

describe("egress cap", () => {
  const local: { test?: TestProxy; stateDir: string } = { stateDir: "" };

  beforeAll(async () => {
    local.stateDir = await createStateDir();
    local.test = await startTestProxy({
      stateDir: local.stateDir,
      policy: { allow: [], mcpHosts: [] },
      cap: { derivedHosts: ["derived.test"], grants: ["*.granted.test"] },
      ports,
    });

    await writeProxyDynamic(local.stateDir, POLICY_HASH, {
      version: 1,
      rules: [],
      derivedHosts: ["derived.test", "clipped.test"],
      tokens: {},
    });

    await addGrant(
      local.stateDir,
      { host: "granted.test", port: 443, scope: { kind: "permanent" } },
      LIMITS,
      Date.now(),
    );
  });

  afterAll(async () => {
    await local.test?.proxy.close();

    await removeDir(local.stateDir);
  });

  const statusOf = async (authority: string) => {
    const token = (await local.test?.tokenOf(REPO)) ?? "";
    const reply = await openConnect(local.test?.proxy.port ?? 0, authority, token);

    reply.socket.destroy();

    return reply.status;
  };

  it("clips derived hosts and grants to the cap", async () => {
    expect(await statusOf("derived.test:443")).toBe(200);
    expect(await statusOf("clipped.test:443")).toBe(403);
    expect(await statusOf("granted.test:443")).toBe(403);
  });
});

describe("plain HTTP", () => {
  it("serves the policy", async () => {
    const policy = JSON.parse(
      (await plainGet(state.test.proxy.port, "/policy", "127.0.0.1", state.token)).body,
    );

    expect(policy).toMatchObject({ allow: ["target.test", "other.test"], policyHash: POLICY_HASH });
  });

  it("denies proxied plain HTTP requests", async () => {
    const denied = await plainGet(state.test.proxy.port, "http://target.test/", "target.test", state.token);

    expect(denied.status).toBe(403);
    expect(denied.headers["proxy-agent"]).toBe("pi-sandbox");
    expect(JSON.parse(denied.body)).toMatchObject({ denied: "target.test", rule: "plain-http" });
  });
});
