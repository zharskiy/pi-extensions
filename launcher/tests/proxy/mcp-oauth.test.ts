import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server } from "node:https";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import { createSecretResolver, type SecretResolver } from "../../proxy/secrets/index.ts";
import type { LauncherCa } from "../../proxy/tls-ca.ts";
import { mcpAuthKey } from "../../shared/index.ts";
import { createFakeClock } from "../support/fake-clock.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { closeServer, createStateDir, listen, openCa, portOf, removeDir, startTestProxy } from "./harness.ts";
import { readBody, requestThrough } from "./proxy-client.ts";

const URL_TEXT = "https://mcp.test/mcp";

const REF = { mcpOAuth: { server: "docs", url: URL_TEXT } };

const KEY = mcpAuthKey("docs", URL_TEXT);

const PLACEHOLDER = "pi-sandbox-0123456789abcdef01234567";

const NOT_SIGNED_IN =
  "pi-sandbox: MCP server docs is not signed in on the host; run pi mcp login docs on the host, then retry.";

const isRunning = (pid: number) => {
  try {
    process.kill(pid, "SIGCONT");

    return true;
  } catch {
    return false;
  }
};

const FAKE_PI = `
import { spawn } from "node:child_process";
import { appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const log = (entry) => appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(entry) + "\\n");
const args = process.argv.slice(2);

log({ args, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), agentDir: process.env.PI_CODING_AGENT_DIR });

const mode = process.env.FAKE_PI_MODE;

if (mode === "sign-in") {
  const store = { [process.env.FAKE_PI_KEY]: { tokens: { access_token: "fresh-token" }, tokensExpireAt: 9e15 } };

  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "mcp-auth.json"), JSON.stringify(store));
}

if (mode === "hang") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

  log({ child: child.pid });

  setInterval(() => {}, 1000);
} else {
  process.exit(mode === "fail" ? 1 : 0);
}
`;

const state = { dir: "", stateDir: "", agentDir: "", script: "", log: "" };

const resolvers: SecretResolver[] = [];

beforeEach(async () => {
  state.dir = await createStateDir();
  state.stateDir = join(state.dir, "state");
  state.agentDir = join(state.dir, "agent");
  state.script = join(state.dir, "fake-pi.mjs");
  state.log = join(state.dir, "pi.log");

  await mkdir(state.agentDir, { recursive: true });

  await writeFile(state.script, FAKE_PI);
});

afterEach(async () => {
  await Promise.all(resolvers.splice(0).map((resolver) => resolver.close()));

  await removeDir(state.dir);
});

const resolverWith = (mode: string, options: { now?: () => number; signInWaitMs?: number } = {}) => {
  const resolver = createSecretResolver({
    runner: createFakeRunner(() => undefined).runner,
    home: state.dir,
    now: options.now ?? Date.now,
    piCommand: [process.execPath, state.script],
    stateDir: state.stateDir,
    hostAgentDir: state.agentDir,
    envSecrets: new Map(),
    childEnv: { FAKE_PI_LOG: state.log, FAKE_PI_MODE: mode, FAKE_PI_KEY: KEY },
    signInWaitMs: options.signInWaitMs ?? 30_000,
  });

  resolvers.push(resolver);

  return resolver;
};

const writeEntry = (access: string, tokensExpireAt: number) =>
  writeFile(
    join(state.agentDir, "mcp-auth.json"),
    JSON.stringify({ [KEY]: { tokens: { access_token: access, refresh_token: "r" }, tokensExpireAt } }),
  );

const piRuns = async () => {
  const text = await readFile(state.log, "utf8").catch(() => "");

  return text
    .split("\n")
    .filter((line) => line !== "")
    .map(
      (line) => JSON.parse(line) as { args?: string[]; cwd?: string; cwdEntries?: string[]; child?: number },
    )
    .filter((entry) => entry.args !== undefined);
};

const waitUntil = async <T>(find: () => Promise<T | undefined>, attempts = 200): Promise<T> => {
  const found = await find();

  if (found !== undefined) {
    return found;
  }

  if (attempts === 0) {
    throw new Error("condition not met");
  }

  await new Promise((resolve) => setTimeout(resolve, 20));

  return waitUntil(find, attempts - 1);
};

const childPid = async () => {
  const text = await readFile(state.log, "utf8").catch(() => "");
  const line = text.split("\n").find((entry) => entry.includes('"child"'));

  return line === undefined ? undefined : (JSON.parse(line) as { child: number }).child;
};

const loginRecord = async () =>
  (JSON.parse(await readFile(join(state.stateDir, "mcp-login.json"), "utf8")) as Record<string, unknown>)[
    KEY
  ];

describe("mcpOAuth secrets read the host pi sign-in", () => {
  it("uses a fresh token without starting a login", async () => {
    await writeEntry("stored-token", Date.now() + 3_600_000);

    const result = await resolverWith("fail").resolve("mcp", REF);

    expect(result).toMatchObject({ ok: true, value: "stored-token" });
    expect(await piRuns()).toEqual([]);
  });

  it("runs the host login when the token expired and uses the new token", async () => {
    await writeEntry("old-token", Date.now() - 1);

    const result = await resolverWith("sign-in").resolve("mcp", REF);
    const [run] = await piRuns();

    expect(result).toMatchObject({ ok: true, value: "fresh-token" });
    expect(run?.args).toEqual(["mcp", "login", "docs", "--timeout", "300"]);
    expect(run?.cwdEntries).toEqual([]);
    expect(run?.cwd?.startsWith(join(await realpath(state.stateDir), "mcp-login-"))).toBe(true);
    expect(await readdir(state.stateDir)).not.toContain(basename(run?.cwd ?? ""));
  });

  it("answers 503 with the sign-in text when the login still runs after the wait", async () => {
    await writeEntry("old-token", Date.now() - 1);

    const result = await resolverWith("hang", { signInWaitMs: 200 }).resolve("mcp", REF);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.reply).toEqual({
      status: 503,
      headers: { "retry-after": "30", "content-type": "text/plain" },
      body: "pi-sandbox: sign-in to MCP server docs opened in the browser on the host; finish it there, then retry. If no browser opened, run pi mcp login docs on the host.",
    });
    expect(await piRuns()).toHaveLength(1);
  });

  it("leaves the credential out and starts nothing when the host holds no token", async () => {
    const result = await resolverWith("sign-in").resolve("mcp", REF);

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? undefined : result.reply).toBeUndefined();
    expect(await piRuns()).toEqual([]);
  });

  it("leaves the credential out, without a sign-in reply, when the login ended or was not started", async () => {
    const clock = createFakeClock(Date.now());

    await writeEntry("old-token", Date.now() - 1);

    const failed = await resolverWith("fail", { now: clock.now }).resolve("mcp", REF);
    const skipped = await resolverWith("fail", { now: clock.now }).resolve("mcp", REF);

    expect(failed.ok ? undefined : failed.reply).toBeUndefined();
    expect(skipped.ok ? undefined : skipped.reply).toBeUndefined();
    expect(await piRuns()).toHaveLength(1);
  });

  it("answers a 401 to a request that carried no token with the not-signed-in text and starts nothing", async () => {
    const reply = await resolverWith("hang").rejected("mcp", REF, undefined);

    expect(reply?.body).toBe(
      "pi-sandbox: MCP server docs is not signed in on the host; run pi mcp login docs on the host, then retry.",
    );
    expect(await piRuns()).toEqual([]);
  });

  it("answers a 401 to a request that carried no token with the opened text while its login runs", async () => {
    await writeEntry("old-token", Date.now() - 1);

    const resolver = resolverWith("hang", { signInWaitMs: 50 });

    expect((await resolver.resolve("mcp", REF)).ok).toBe(false);

    const reply = await resolver.rejected("mcp", REF, undefined);

    expect(reply?.body).toBe(
      "pi-sandbox: sign-in to MCP server docs opened in the browser on the host; finish it there, then retry. If no browser opened, run pi mcp login docs on the host.",
    );
    expect(await piRuns()).toHaveLength(1);
  });

  it("answers a 401 to a request that carried no token with the not-signed-in text once its login ended", async () => {
    await writeEntry("old-token", Date.now() - 1);

    const resolver = resolverWith("fail");

    expect((await resolver.resolve("mcp", REF)).ok).toBe(false);

    const reply = await resolver.rejected("mcp", REF, undefined);

    expect(reply?.body).toBe(NOT_SIGNED_IN);
    expect(await loginRecord()).toEqual({ lastStart: expect.any(Number), failedAt: expect.any(Number) });
  });

  it("clears an earlier failure once a login succeeds", async () => {
    await writeEntry("old-token", Date.now() - 1);

    await mkdir(state.stateDir, { recursive: true });

    await writeFile(
      join(state.stateDir, "mcp-login.json"),
      JSON.stringify({ [KEY]: { failedAt: Date.now() - 11 * 60_000 } }),
    );

    expect(await resolverWith("sign-in").resolve("mcp", REF)).toMatchObject({
      ok: true,
      value: "fresh-token",
    });
    expect(await loginRecord()).not.toHaveProperty("failedAt");
  });

  it("uses a token signed in on the host right after a sign-in reply, without waiting out the failure cache", async () => {
    await writeEntry("old-token", Date.now() - 1);

    const resolver = resolverWith("hang", { signInWaitMs: 50 });
    const first = await resolver.resolve("mcp", REF);

    expect(first.ok ? undefined : first.reply?.status).toBe(503);

    await writeEntry("signed-in-token", Date.now() + 3_600_000);

    expect(await resolver.resolve("mcp", REF)).toMatchObject({ ok: true, value: "signed-in-token" });
  });

  it("uses a token signed in on the host right after a request that went out without one", async () => {
    const resolver = resolverWith("fail");
    const first = await resolver.resolve("mcp", REF);

    expect(first.ok ? undefined : first.reply).toBeUndefined();

    await writeEntry("signed-in-token", Date.now() + 3_600_000);

    expect(await resolver.resolve("mcp", REF)).toMatchObject({ ok: true, value: "signed-in-token" });
  });

  it("starts nothing within 60 s of a start, even from a second resolver on the same state dir", async () => {
    const clock = createFakeClock(Date.now());

    await writeEntry("old-token", Date.now() - 1);

    const tryLogin = async () => {
      const resolver = resolverWith("hang", { now: clock.now, signInWaitMs: 50 });
      const result = await resolver.resolve("mcp", REF);

      await resolver.close();

      return result.ok;
    };

    expect(await tryLogin()).toBe(false);

    clock.advance(30_000);

    expect(await tryLogin()).toBe(false);
    expect(await piRuns()).toHaveLength(1);

    clock.advance(31_000);

    await tryLogin();

    expect(await piRuns()).toHaveLength(2);
  });

  it("starts nothing within 10 min of a failed login", async () => {
    const clock = createFakeClock(Date.now());

    await writeEntry("old-token", Date.now() - 1);

    expect((await resolverWith("fail", { now: clock.now }).resolve("mcp", REF)).ok).toBe(false);

    await waitUntil(async () => ((await loginRecord()) as { failedAt?: number } | undefined)?.failedAt);

    clock.advance(5 * 60_000);

    await resolverWith("fail", { now: clock.now }).resolve("mcp", REF);

    expect(await piRuns()).toHaveLength(1);

    clock.advance(6 * 60_000);

    await resolverWith("fail", { now: clock.now }).resolve("mcp", REF);

    expect(await piRuns()).toHaveLength(2);
  });

  it("starts a login after a 401 to an injected token at most once in 10 min, even when it succeeds", async () => {
    const clock = createFakeClock(Date.now());
    const resolver = resolverWith("noop", { now: clock.now });

    await writeEntry("stored-token", Date.now() + 3_600_000);

    await resolver.rejected("mcp", REF, "stored-token");

    await waitUntil(async () => ((await piRuns()).length > 0 ? true : undefined));

    clock.advance(61_000);

    expect((await resolver.resolve("mcp", REF)).ok).toBe(false);

    await resolver.rejected("mcp", REF, "stored-token");

    clock.advance(5 * 60_000);

    await resolverWith("noop", { now: clock.now }).rejected("mcp", REF, "stored-token");

    expect(await piRuns()).toHaveLength(1);
    expect(await loginRecord()).toEqual(expect.objectContaining({ rejectedStart: expect.any(Number) }));

    clock.advance(5 * 60_000);

    await resolver.rejected("mcp", REF, "stored-token");

    await waitUntil(async () => ((await piRuns()).length === 2 ? true : undefined));
  });

  it("never names a token in a failure", async () => {
    await writeEntry("expired-token-value", Date.now() - 1);

    const result = await resolverWith("fail").resolve("mcp", REF);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("expired-token-value");
    expect(await readdir(state.stateDir)).not.toContain("mcp-auth.json");
  });
});

describe("mcpOAuth sign-in through the proxy", () => {
  const RULE: CredentialRule = { id: "mcp", host: "mcp.test", placeholder: PLACEHOLDER, secret: REF };

  const proxy: { ca?: LauncherCa; upstream?: Server; seen: Array<string | undefined>; accepting: boolean } = {
    seen: [],
    accepting: false,
  };

  beforeAll(async () => {
    const caDir = await createStateDir();

    proxy.ca = await openCa(caDir);
    proxy.upstream = createHttpsServer(await proxy.ca.leaf("mcp.test"), (request, response) => {
      proxy.seen.push(request.headers.authorization);

      if (proxy.accepting && request.headers.authorization === "Bearer stored-token") {
        response.writeHead(200, { "content-type": "application/json" });

        response.end("{}");

        return;
      }

      response.writeHead(401, { "www-authenticate": "Bearer" });

      response.end("{}");
    });

    await listen(proxy.upstream);
  }, 30_000);

  afterAll(async () => {
    await closeServer(proxy.upstream);
  });

  const started = async (
    mode: string,
    expiresAt: number | null = Date.now() + 3_600_000,
    signInWaitMs?: number,
  ) => {
    if (expiresAt !== null) {
      await writeEntry("stored-token", expiresAt);
    }

    const ca = proxy.ca as LauncherCa;
    const resolver = resolverWith(mode, { signInWaitMs });
    const test = await startTestProxy({
      stateDir: state.stateDir,
      policy: { allow: [] },
      ca,
      rules: [RULE],
      resolver,
      ports: () => ({ "mcp.test:443": portOf(proxy.upstream as Server) }),
    });
    const token = test.token;

    const send = async (authorization: string) => {
      const response = await requestThrough({
        proxyPort: test.proxy.port,
        token,
        host: "mcp.test",
        ca: ca.certPem,
        path: "/mcp",
        headers: { authorization },
      });

      return { status: response.statusCode, body: await readBody(response) };
    };

    return { test, send };
  };

  it("turns a 401 to the token it injected into the 503 sign-in reply and starts the login", async () => {
    const { test, send } = await started("hang");
    const reply = await send(`Bearer ${PLACEHOLDER}`);

    await waitUntil(async () => ((await piRuns()).length > 0 ? true : undefined));

    await test.proxy.close();

    expect(proxy.seen.at(-1)).toBe("Bearer stored-token");
    expect(reply.status).toBe(503);
    expect(reply.body).toContain("sign-in to MCP server docs opened in the browser on the host");
    expect(await piRuns()).toHaveLength(1);
  });

  it("forwards a request without a credential when the host holds no token and answers its 401 with the not-signed-in reply", async () => {
    const { test, send } = await started("hang", null);
    const reply = await send(`Bearer ${PLACEHOLDER}`);

    await test.proxy.close();

    expect(proxy.seen.at(-1)).toBeUndefined();
    expect(reply.status).toBe(503);
    expect(reply.body).toContain(
      "pi-sandbox: MCP server docs is not signed in on the host; run pi mcp login docs on the host, then retry.",
    );
    expect(await piRuns()).toEqual([]);
  });

  it("forwards a request without the expired token when the host login fails", async () => {
    const { test, send } = await started("fail", Date.now() - 1);
    const reply = await send(`Bearer ${PLACEHOLDER}`);

    await test.proxy.close();

    expect(proxy.seen.at(-1)).toBeUndefined();
    expect(reply.status).toBe(503);
    expect(reply.body).toContain("MCP server docs is not signed in on the host");
    expect(await piRuns()).toHaveLength(1);
  });

  it("injects an expired token the host login has just confirmed", async () => {
    proxy.accepting = true;

    const { test, send } = await started("noop", Date.now() - 1);
    const reply = await send(`Bearer ${PLACEHOLDER}`);

    await test.proxy.close();

    proxy.accepting = false;

    expect(proxy.seen.at(-1)).toBe("Bearer stored-token");
    expect(reply.status).toBe(200);
    expect(await piRuns()).toHaveLength(1);
  });

  it("drops a confirmed expired token once the upstream rejects it, without a second login", async () => {
    proxy.accepting = true;

    const { test, send } = await started("noop", Date.now() - 1);

    expect((await send(`Bearer ${PLACEHOLDER}`)).status).toBe(200);

    proxy.accepting = false;

    const rejectedReply = await send(`Bearer ${PLACEHOLDER}`);

    expect(proxy.seen.at(-1)).toBe("Bearer stored-token");

    const after = await send(`Bearer ${PLACEHOLDER}`);

    await test.proxy.close();

    expect(proxy.seen.at(-1)).toBeUndefined();
    expect([rejectedReply.status, after.status]).toEqual([503, 503]);
    expect([rejectedReply.body, after.body]).toEqual([NOT_SIGNED_IN, NOT_SIGNED_IN]);
    expect(await piRuns()).toHaveLength(1);
  });

  it("passes a 401 to the container's own Authorization through and starts nothing", async () => {
    const { test, send } = await started("hang");
    const reply = await send("Bearer own-token");

    await test.proxy.close();

    expect(proxy.seen.at(-1)).toBe("Bearer own-token");
    expect(reply.status).toBe(401);
    expect(await piRuns()).toEqual([]);
  });

  it("kills the login's process group when the proxy stops", async () => {
    const { test, send } = await started("hang", Date.now() - 1, 200);

    expect((await send(`Bearer ${PLACEHOLDER}`)).status).toBe(503);

    const child = await waitUntil(childPid);

    expect(isRunning(child)).toBe(true);

    await test.proxy.close();

    await waitUntil(async () => (isRunning(child) ? undefined : true));
  });
});
