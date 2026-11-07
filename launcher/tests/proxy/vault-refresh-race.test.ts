import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSecretResolver } from "../../proxy/secrets/index.ts";
import type { LauncherCa } from "../../proxy/tls-ca.ts";
import { stateLayout, writeVaultEntry } from "../../shared/index.ts";
import { createFakeClock } from "../support/fake-clock.ts";
import { createFakeRunner, type FakeCall } from "../support/fake-runner.ts";
import { closeServer, createStateDir, openCa, removeDir } from "./harness.ts";
import { readBody, requestThrough } from "./proxy-client.ts";
import {
  MCP_URL,
  PLACEHOLDERS,
  postThrough,
  sendJson,
  startUpstream,
  startVaultProxy,
  type Upstream,
  type VaultProxy,
} from "./vault-fixture.ts";

const KEY = `mcp__docs|${new URL(MCP_URL).href}`;

const LIFETIME_MS = 60_000;

const PI_SKEW_MS = 30_000;

interface StoredEntry {
  serverUrl: string;
  tokens?: { access_token: string; token_type: string; refresh_token: string };
  tokensExpireAt?: number;
}

const shared: { caDir: string; ca: LauncherCa; upstream: Upstream } = {
  caDir: "",
  ca: undefined as unknown as LauncherCa,
  upstream: undefined as unknown as Upstream,
};

const state = {
  stateDir: "",
  proxy: undefined as unknown as VaultProxy,
  clock: createFakeClock(),
  serial: 0,
  liveRefresh: new Set<string>(),
  refreshes: [] as string[],
  reused: [] as string[],
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const issue = () => {
  state.serial += 1;

  const refresh = `real-refresh-${state.serial}`;

  state.liveRefresh.add(refresh);

  return {
    tokens: { access_token: `real-access-${state.serial}`, token_type: "Bearer", refresh_token: refresh },
    tokensExpireAt: state.clock.now() + LIFETIME_MS,
  };
};

const hostPi = async (call: FakeCall) => {
  const path = join(call.options.env?.PI_CODING_AGENT_DIR ?? "", "mcp-auth.json");
  const store = JSON.parse(await readFile(path, "utf8")) as Record<string, StoredEntry>;
  const entry = store[KEY];
  const expired =
    entry?.tokensExpireAt !== undefined && entry.tokensExpireAt - PI_SKEW_MS <= state.clock.now();

  if (entry?.tokens === undefined || !expired) {
    return { stdout: "" };
  }

  const presented = entry.tokens.refresh_token;

  await delay(40);

  if (!state.liveRefresh.delete(presented)) {
    state.reused.push(presented);

    const { tokens: _gone, tokensExpireAt: _expiry, ...signedOut } = entry;

    await writeFile(path, JSON.stringify({ [KEY]: signedOut }));

    return { stdout: "" };
  }

  state.refreshes.push(presented);

  await writeFile(path, JSON.stringify({ [KEY]: { ...entry, ...issue() } }));

  return { stdout: "" };
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
  state.clock = createFakeClock();
  state.serial = 0;
  state.liveRefresh = new Set();
  state.refreshes = [];
  state.reused = [];
  shared.upstream.calls.length = 0;
  shared.upstream.handler.current = (call, response) =>
    sendJson(response, 200, { authorization: call.headers.authorization ?? "" });

  const resolver = createSecretResolver({
    runner: createFakeRunner(hostPi).runner,
    home: state.stateDir,
    now: state.clock.now,
    piCommand: ["/usr/bin/node", "/opt/pi/cli.js"],
    mcpAuthDir: stateLayout(state.stateDir).mcpAuth,
    envSecrets: async () => new Map(),
  });

  await mkdir(join(stateLayout(state.stateDir).mcpAuth, "servers"), { recursive: true });

  await writeFile(
    join(stateLayout(state.stateDir).mcpAuth, "servers", "docs.json"),
    JSON.stringify({ url: MCP_URL }),
  );

  await writeVaultEntry(state.stateDir, KEY, {
    serverUrl: MCP_URL,
    clientInformation: { client_id: "public-client" },
    ...issue(),
  });

  state.proxy = await startVaultProxy({
    stateDir: state.stateDir,
    ca: shared.ca,
    upstream: shared.upstream,
    resolver,
    now: state.clock.now,
  });
});

afterEach(async () => {
  await state.proxy.test.proxy.close();

  await removeDir(state.stateDir);
});

const refreshForm = new URLSearchParams({
  grant_type: "refresh_token",
  refresh_token: PLACEHOLDERS.refresh,
  client_id: "public-client",
}).toString();

const mcpCall = async () => {
  const response = await requestThrough({
    proxyPort: state.proxy.test.proxy.port,
    token: state.proxy.token,
    host: "mcp.test",
    ca: state.proxy.caPem,
    path: "/mcp",
    method: "POST",
    headers: { authorization: `Bearer ${PLACEHOLDERS.access}`, "content-type": "application/json" },
    body: "{}",
  });

  return {
    status: response.statusCode ?? 0,
    body: JSON.parse(await readBody(response)) as { authorization: string },
  };
};

describe("vault refresh after expiry with rotating refresh tokens", () => {
  it("refreshes once on the host for concurrent placeholder refreshes and MCP calls", async () => {
    expect((await mcpCall()).body.authorization).toBe("Bearer real-access-1");

    state.clock.advance(LIFETIME_MS + 30_000);

    const replies = await Promise.all([
      postThrough(state.proxy, "auth.test", "/token", refreshForm),
      mcpCall(),
      postThrough(state.proxy, "auth.test", "/token", refreshForm),
      mcpCall(),
    ]);

    state.clock.advance(5_000);

    const after = await Promise.all([
      postThrough(state.proxy, "auth.test", "/token", refreshForm),
      mcpCall(),
    ]);

    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200]);
    expect(after.map((reply) => reply.status)).toEqual([200, 200]);
    expect(after[1]?.body.authorization).toBe("Bearer real-access-2");
    expect(state.refreshes).toEqual(["real-refresh-1"]);
    expect(state.reused).toEqual([]);
  });
});
