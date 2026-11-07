import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { followRedirects } from "./fixtures/browser.ts";
import { type McpFixture, startMcpFixture } from "./fixtures/mcp-fixture.ts";
import { type OAuthFixture, startOAuthFixture } from "./fixtures/oauth-fixture.ts";
import { ALL_FIXTURE_HOSTS, FIXTURE_HOSTS, LOOPBACK } from "./harness/names.ts";
import { createLiveSandbox, type LiveSandbox, liveEnabled } from "./harness/sandbox.ts";
import { fixtureConfig, waitFor } from "./harness/scenario.ts";
import { sweepSandbox } from "./harness/sweep.ts";

const TOOL = "oauth_fixture_tool";

const SERVER = "oauth-fixture";

const ACCESS_LIFETIME_SECONDS = Number(process.env.PI_SANDBOX_LIVE_OAUTH_LIFETIME ?? "60");

const AUTHORIZE_URL = /https:\/\/\S+\/authorize\?\S+/;

const PLACEHOLDER = /^pi-sandbox-[0-9a-f]{24}$/;

interface RenderedServer {
  url?: string;
  headers?: Record<string, string>;
  oauth?: Record<string, unknown>;
}

interface AuthEntry {
  serverUrl?: string;
  tokens?: { access_token?: string };
}

const tokenSecrets = (oauth: OAuthFixture) =>
  Object.fromEntries([...oauth.issuedAccess(), ...oauth.issuedRefresh()].map((value) => [value, value]));

describe.skipIf(!liveEnabled)("HTTP MCP server with OAuth (live)", () => {
  const state: { sandbox?: LiveSandbox; oauth?: OAuthFixture; mcp?: McpFixture } = {};

  beforeAll(async () => {
    const sandbox = await createLiveSandbox("mcp-oauth");
    const oauth = await startOAuthFixture(sandbox.certificate, FIXTURE_HOSTS.auth, ACCESS_LIFETIME_SECONDS);

    state.sandbox = sandbox;

    state.oauth = oauth;

    state.mcp = await startMcpFixture(sandbox.certificate, {
      tool: TOOL,
      authorize: (token) => oauth.isValidAccess(token),
      authorizationServer: () => oauth.issuer(FIXTURE_HOSTS.auth),
    });

    await sandbox.writeAgentFile("mcp.json", {
      mcpServers: { [SERVER]: { url: state.mcp.endpoint(FIXTURE_HOSTS.oauthMcp) } },
    });

    await sandbox.writeUserConfig(fixtureConfig(sandbox));
  }, 120_000);

  afterAll(async () => {
    await state.mcp?.close();

    await state.oauth?.close();

    await state.sandbox?.cleanup();
  }, 120_000);

  it("signs in on the host through the printed authorize URL and the host callback", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const login = sandbox.pi(["mcp", "login", SERVER]);
    const exited = { done: false };

    void login.done.then(() => {
      exited.done = true;
    });

    const url = await waitFor(async () => {
      const opened = await sandbox.openedUrls();

      return opened[0] ?? AUTHORIZE_URL.exec(login.output())?.[0] ?? (exited.done ? "" : undefined);
    }, 300_000);

    expect(url).toMatch(AUTHORIZE_URL);

    const callback = await followRedirects(url, sandbox.ca.certPem, (host) =>
      ALL_FIXTURE_HOSTS.includes(host) ? LOOPBACK : undefined,
    );

    expect(callback.status).toBe(200);

    const result = await login.done;

    expect(result.code).toBe(0);

    expect(state.oauth?.grants()).toEqual(["authorization_code"]);
  });

  it("calls the server from the container with the token the proxy injects", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const oauth = state.oauth as OAuthFixture;
    const result = await sandbox.pi(["mcp", "list"]).done;

    expect(result.code).toBe(0);

    expect(result.stdout).toContain(TOOL);

    expect(state.mcp?.tokens().at(-1)).toBe(oauth.issuedAccess().at(-1));
  });

  it("renders a vault server and keeps only placeholders in the container's mcp-auth.json", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const oauth = state.oauth as OAuthFixture;
    const auth = await sandbox.exec("cat ~/.pi/agent/mcp-auth.json");
    const config = await sandbox.exec("cat ~/.pi/agent/mcp.json");

    expect(auth.code).toBe(0);

    expect(config.code).toBe(0);

    const server = (JSON.parse(config.stdout) as { mcpServers: Record<string, RenderedServer> }).mcpServers[
      SERVER
    ];

    expect(server?.url).toBe(state.mcp?.endpoint(FIXTURE_HOSTS.oauthMcp));

    expect(Object.keys(server?.headers ?? {}).map((header) => header.toLowerCase())).not.toContain(
      "authorization",
    );

    Object.values(server?.oauth ?? {}).forEach((value) => {
      expect(["string", "number", "boolean"]).toContain(typeof value);
    });

    const entry = Object.values(JSON.parse(auth.stdout) as Record<string, AuthEntry>).find(
      (candidate) => candidate.serverUrl === server?.url,
    );

    expect(entry?.tokens?.access_token).toMatch(PLACEHOLDER);

    [...oauth.issuedAccess(), ...oauth.issuedRefresh()].forEach((token) => {
      expect(auth.stdout).not.toContain(token);

      expect(config.stdout).not.toContain(token);
    });
  });

  it("refreshes the expired access token in the proxy", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const oauth = state.oauth as OAuthFixture;
    const first = oauth.issuedAccess()[0];

    await new Promise((resolve) => setTimeout(resolve, (ACCESS_LIFETIME_SECONDS + 5) * 1000));

    const result = await sandbox.pi(["mcp", "list"]).done;

    expect(result.code).toBe(0);

    expect(result.stdout).toContain(TOOL);

    expect(oauth.grants()).toContain("refresh_token");

    const latest = state.mcp?.tokens().at(-1) ?? "";

    expect(latest).not.toBe(first);

    expect(oauth.isValidAccess(latest)).toBe(true);
  });

  it("leaves no OAuth token in the container filesystem or env", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const { findings } = await sweepSandbox(sandbox, tokenSecrets(state.oauth as OAuthFixture));

    expect(findings).toEqual([]);
  });
});
