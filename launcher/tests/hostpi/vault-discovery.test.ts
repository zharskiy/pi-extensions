import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BundledPi, discoverVaultServers, mcpDiscoverCommand } from "../../hostpi/index.ts";
import { createProcessRunner, launcherRoot, readJsonFile, stateLayout } from "../../shared/index.ts";
import { argvOf, createFakeRunner, type FakeCall } from "../support/fake-runner.ts";
import { tempDir } from "./fixtures.ts";

const PI: BundledPi = {
  command: [process.execPath, "/opt/pi/cli.js"],
  version: "1.5.0",
  packageDir: join(launcherRoot(), "..", "node_modules", "@earendil-works", "pi-coding-agent"),
};

const URL_A = "https://mcp.a.example/mcp";

const HOUR = 60 * 60 * 1000;

const found = {
  ok: true,
  url: URL_A,
  issuer: "https://auth.a.example/",
  authorizationEndpoint: "https://login.a.example/authorize",
  tokenEndpoint: "https://auth.a.example/token",
  registrationEndpoint: "https://auth.a.example/register",
  resource: URL_A,
  hosts: ["auth.a.example", "mcp.a.example"],
  piState: { authorizationServerUrl: "https://auth.a.example/" },
};

const clock = (start: number) => {
  const time = { now: start };

  return { now: () => time.now, advance: (ms: number) => (time.now += ms) };
};

const runnerAnswering = (answer: { code?: number; stdout?: string; stderr?: string }) =>
  createFakeRunner(() => answer);

const discoverWith = (stateDir: string, runner: ReturnType<typeof createFakeRunner>, now: () => number) =>
  discoverVaultServers({
    stateDir,
    runner: runner.runner,
    pi: PI,
    candidates: { alpha: { url: URL_A, oauth: { authServerMetadataUrl: "https://auth.a.example/meta" } } },
    now,
  });

const requestOf = (call: FakeCall | undefined) => JSON.parse(call?.options.input ?? "null");

describe("discoverVaultServers", () => {
  it("runs the discovery script with the server on stdin and caches a success for a day with mode 600", async () => {
    const stateDir = await tempDir("vault-discovery");
    const fake = runnerAnswering({ stdout: `${JSON.stringify(found)}\n` });
    const time = clock(10 * HOUR);
    const first = await discoverWith(stateDir, fake, time.now);

    time.advance(23 * HOUR);

    const cached = await discoverWith(stateDir, fake, time.now);
    const path = stateLayout(stateDir).mcpAuthDiscovery("alpha");

    expect(first).toEqual({
      discovery: { alpha: { ...found, server: "alpha", fetchedAt: 10 * HOUR } },
      notices: [],
    });
    expect(cached).toEqual(first);
    expect(fake.calls.map(argvOf)).toEqual([mcpDiscoverCommand(PI)]);
    expect(requestOf(fake.calls[0])).toEqual({
      url: URL_A,
      authServerMetadataUrl: "https://auth.a.example/meta",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readJsonFile(path)).toEqual(first.discovery.alpha);

    time.advance(2 * HOUR);

    await discoverWith(stateDir, fake, time.now);

    expect(fake.calls).toHaveLength(2);
  });

  it("reports a failure with a notice and retries it only after a minute", async () => {
    const stateDir = await tempDir("vault-discovery");
    const fake = runnerAnswering({ code: 1, stderr: "connection refused\n" });
    const time = clock(5_000);
    const first = await discoverWith(stateDir, fake, time.now);

    time.advance(30_000);

    await discoverWith(stateDir, fake, time.now);

    expect(first.discovery.alpha).toEqual({
      ok: false,
      server: "alpha",
      url: URL_A,
      fetchedAt: 5_000,
      error: "connection refused",
    });
    expect(first.notices).toEqual([
      "mcp alpha: sign-in discovery failed (connection refused); this launch uses the host sign-in instead",
    ]);
    expect(fake.calls).toHaveLength(1);

    time.advance(31_000);

    await discoverWith(stateDir, fake, time.now);

    expect(fake.calls).toHaveLength(2);
  });

  it("treats output that is not a discovery record as a failure", async () => {
    const stateDir = await tempDir("vault-discovery");
    const fake = runnerAnswering({ stdout: '{"ok":true,"issuer":1}' });
    const result = await discoverWith(stateDir, fake, () => 1);

    expect(result.discovery.alpha).toMatchObject({ ok: false, error: "unreadable discovery output" });
  });

  it("rediscovers when the cached record is for another url", async () => {
    const stateDir = await tempDir("vault-discovery");
    const fake = runnerAnswering({ stdout: JSON.stringify(found) });

    await discoverWith(stateDir, fake, () => 1);

    await discoverVaultServers({
      stateDir,
      runner: fake.runner,
      pi: PI,
      candidates: { alpha: { url: "https://mcp.a.example/other" } },
      now: () => 2,
    });

    expect(fake.calls).toHaveLength(2);
    expect(requestOf(fake.calls[1])).toEqual({ url: "https://mcp.a.example/other" });
  });
});

type Handler = (request: IncomingMessage, response: ServerResponse, origin: string) => void;

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
  );
});

const serve = async (handler: Handler) => {
  const server = createServer((request, response) => handler(request, response, originOf(server)));

  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  return originOf(server);
};

const originOf = (server: ReturnType<typeof createServer>) =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const json = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });

  response.end(JSON.stringify(body));
};

const realDiscovery = (stateDir: string, url: string) =>
  discoverVaultServers({
    stateDir,
    runner: createProcessRunner(),
    pi: PI,
    candidates: { live: { url } },
    now: () => 1,
  });

describe("mcp-discover.mjs", () => {
  it("follows the initialize challenge to the resource metadata and the authorization server", async () => {
    const issuer = await serve((request, response, origin) => {
      if (request.url === "/.well-known/oauth-authorization-server") {
        json(response, 200, {
          issuer: `${origin}/`,
          authorization_endpoint: "https://login.vault.example/authorize",
          token_endpoint: "https://tokens.vault.example/token",
          registration_endpoint: "https://register.vault.example/register",
          response_types_supported: ["code"],
        });

        return;
      }

      json(response, 404, {});
    });
    const seen: string[] = [];
    const mcp = await serve((request, response, origin) => {
      seen.push(`${request.method} ${request.url}`);

      if (request.method === "POST" && request.url === "/mcp") {
        json(response, 401, {}, { "www-authenticate": `Bearer resource_metadata="${origin}/meta/mcp"` });

        return;
      }

      if (request.url === "/meta/mcp") {
        json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [`${issuer}/`] });

        return;
      }

      json(response, 404, {});
    });
    const stateDir = await tempDir("vault-discovery");
    const result = await realDiscovery(stateDir, `${mcp}/mcp`);
    const host = (origin: string) => new URL(origin).host;

    expect(seen.slice(0, 2)).toEqual(["POST /mcp", "GET /meta/mcp"]);
    expect(result.discovery.live).toMatchObject({
      ok: true,
      issuer: `${issuer}/`,
      authorizationEndpoint: "https://login.vault.example/authorize",
      tokenEndpoint: "https://tokens.vault.example/token",
      registrationEndpoint: "https://register.vault.example/register",
      resource: `${mcp}/mcp`,
      resourceMetadataUrl: `${mcp}/meta/mcp`,
      hosts: [host(mcp), host(issuer), "register.vault.example", "tokens.vault.example"].sort(),
      piState: { authorizationServerUrl: `${issuer}/`, resourceMetadataUrl: `${mcp}/meta/mcp` },
    });
  });

  it("falls back to /authorize, /token and /register on the server origin without any metadata", async () => {
    const mcp = await serve((request, response) => json(response, request.method === "POST" ? 401 : 404, {}));
    const stateDir = await tempDir("vault-discovery");
    const result = await realDiscovery(stateDir, `${mcp}/mcp`);

    expect(result.discovery.live).toMatchObject({
      ok: true,
      issuer: `${mcp}/`,
      authorizationEndpoint: `${mcp}/authorize`,
      tokenEndpoint: `${mcp}/token`,
      registrationEndpoint: `${mcp}/register`,
      hosts: [new URL(mcp).host],
    });
    expect(result.notices).toEqual([]);
  });

  it("reports a server that cannot be reached as a failed discovery", async () => {
    const mcp = await serve((_request, response) => json(response, 404, {}));

    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
    );

    const stateDir = await tempDir("vault-discovery");
    const result = await realDiscovery(stateDir, `${mcp}/mcp`);

    expect(result.discovery.live?.ok).toBe(false);
    expect(result.notices).toHaveLength(1);
  });
});
