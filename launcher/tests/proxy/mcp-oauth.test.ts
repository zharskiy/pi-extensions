import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server } from "node:https";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import { createSecretResolver, type SecretResolver } from "../../proxy/secrets/index.ts";
import type { LauncherCa } from "../../proxy/tls-ca.ts";
import { isProcessAlive, mcpAuthKey } from "../../shared/index.ts";
import { createFakeClock } from "../support/fake-clock.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { closeServer, createStateDir, listen, openCa, portOf, removeDir, startTestProxy } from "./harness.ts";
import { readBody, requestThrough } from "./proxy-client.ts";

const URL_TEXT = "https://mcp.test/mcp";

const REF = { mcpOAuth: { server: "docs", url: URL_TEXT } };

const KEY = mcpAuthKey("docs", URL_TEXT);

const PLACEHOLDER = "pi-sandbox-0123456789abcdef01234567";

const REPO = "1".repeat(64);

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
    envSecrets: async () => new Map(),
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
    const result = await resolverWith("hang", { signInWaitMs: 200 }).resolve("mcp", REF);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.reply).toEqual({
      status: 503,
      headers: { "retry-after": "30", "content-type": "text/plain" },
      body: "pi-sandbox: sign-in to MCP server docs opened in the browser on the host; finish it there, then retry. If no browser opened, run pi mcp login docs on the host.",
    });
    expect(await piRuns()).toHaveLength(1);
  });

  it("starts nothing within 60 s of a start, even from a second resolver on the same state dir", async () => {
    const clock = createFakeClock(Date.now());

    await writeEntry("old-token", Date.now() - 1);

    expect((await resolverWith("noop", { now: clock.now }).resolve("mcp", REF)).ok).toBe(false);

    clock.advance(30_000);

    expect((await resolverWith("noop", { now: clock.now }).resolve("mcp", REF)).ok).toBe(false);
    expect(await piRuns()).toHaveLength(1);

    clock.advance(31_000);

    await resolverWith("noop", { now: clock.now }).resolve("mcp", REF);

    expect(await piRuns()).toHaveLength(2);
  });

  it("starts nothing within 10 min of a failed login", async () => {
    const clock = createFakeClock(Date.now());

    expect((await resolverWith("fail", { now: clock.now }).resolve("mcp", REF)).ok).toBe(false);

    await waitUntil(async () => ((await loginRecord()) as { failedAt?: number } | undefined)?.failedAt);

    clock.advance(5 * 60_000);

    await resolverWith("fail", { now: clock.now }).resolve("mcp", REF);

    expect(await piRuns()).toHaveLength(1);

    clock.advance(6 * 60_000);

    await resolverWith("fail", { now: clock.now }).resolve("mcp", REF);

    expect(await piRuns()).toHaveLength(2);
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

  const proxy: { ca?: LauncherCa; upstream?: Server; seen: Array<string | undefined> } = { seen: [] };

  beforeAll(async () => {
    const caDir = await createStateDir();

    proxy.ca = await openCa(caDir);
    proxy.upstream = createHttpsServer(await proxy.ca.leaf("mcp.test"), (request, response) => {
      proxy.seen.push(request.headers.authorization);

      response.writeHead(401, { "www-authenticate": "Bearer" });

      response.end("{}");
    });

    await listen(proxy.upstream);
  }, 30_000);

  afterAll(async () => {
    await closeServer(proxy.upstream);
  });

  const started = async (mode: string, expiresAt = Date.now() + 3_600_000) => {
    await writeEntry("stored-token", expiresAt);

    const ca = proxy.ca as LauncherCa;
    const resolver = resolverWith(mode, { signInWaitMs: 200 });
    const test = await startTestProxy({
      stateDir: state.stateDir,
      policy: { allow: [], credentialHosts: ["mcp.test"] },
      ca,
      rules: [RULE],
      resolver,
      ports: () => ({ "mcp.test:443": portOf(proxy.upstream as Server) }),
    });
    const token = await test.tokenOf(REPO);

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

  it("passes a 401 to the container's own Authorization through and starts nothing", async () => {
    const { test, send } = await started("hang");
    const reply = await send("Bearer own-token");

    await test.proxy.close();

    expect(proxy.seen.at(-1)).toBe("Bearer own-token");
    expect(reply.status).toBe(401);
    expect(await piRuns()).toEqual([]);
  });

  it("kills the login's process group when the proxy stops", async () => {
    const { test, send } = await started("hang", Date.now() - 1);

    expect((await send(`Bearer ${PLACEHOLDER}`)).status).toBe(503);

    const child = await waitUntil(childPid);

    expect(isProcessAlive(child)).toBe(true);

    await test.proxy.close();

    await waitUntil(async () => (isProcessAlive(child) ? undefined : true));
  });
});
