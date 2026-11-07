import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { launcherRoot, OAUTH_CALLBACK_STATUS, OAUTH_ROUTES } from "../../shared/index.ts";

interface ShimModule {
  ROUTES: typeof OAUTH_ROUTES;
  CALLBACK_STATUS: typeof OAUTH_CALLBACK_STATUS;
  HEALTH_ROUTE: string;
  CHECK_FLAG: string;
}

const SHIM = join(launcherRoot(), "image", "xdg-open.mjs");

const { CALLBACK_STATUS, CHECK_FLAG, HEALTH_ROUTE, ROUTES } = (await import(
  pathToFileURL(SHIM).href
)) as ShimModule;

const TOKEN = "repo-token-1";

const AUTHORIZE = "https://auth.vault.example/authorize?response_type=code&state=s1";

interface Seen {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

type Reply = (seen: Seen) => { status: number; body?: unknown };

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
  );
});

const bodyOf = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));

    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

const answer = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });

  response.end(body === undefined ? undefined : JSON.stringify(body));
};

const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(handler);

  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  return (server.address() as AddressInfo).port;
};

const fakeProxy = async (reply: Reply) => {
  const seen: Seen[] = [];
  const port = await listen(async (request, response) => {
    const entry = {
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers["proxy-authorization"],
      body: await bodyOf(request),
    };

    seen.push(entry);

    const result = reply(entry);

    answer(response, result.status, result.body);
  });

  return { seen, proxy: `http://pi-sandbox:${TOKEN}@127.0.0.1:${port}` };
};

const fakePi = async () => {
  const seen: string[] = [];
  const port = await listen((request, response) => {
    seen.push(request.url ?? "");

    response.end("Signed in.");
  });

  return { seen, port };
};

const closedPort = async () => {
  const port = await listen(() => undefined);

  await new Promise((resolve) => servers.pop()?.close(() => resolve(undefined)));

  return port;
};

const runShim = (args: string[], proxy?: string) =>
  new Promise<{ code: number; stderr: string; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [SHIM, ...args], {
      env: { PATH: process.env.PATH ?? "", ...(proxy === undefined ? {} : { HTTPS_PROXY: proxy }) },
    });
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));

    child.once("close", (code) =>
      resolve({
        code: code ?? 1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }),
    );
  });

const BASIC = `Basic ${Buffer.from(`pi-sandbox:${TOKEN}`).toString("base64")}`;

describe("xdg-open shim", () => {
  it("uses the same routes and statuses as the proxy", () => {
    expect(ROUTES).toEqual(OAUTH_ROUTES);
    expect(CALLBACK_STATUS).toEqual(OAUTH_CALLBACK_STATUS);
  });

  it("opens the flow, waits for the callback and replays its query to pi's listener", async () => {
    const pi = await fakePi();
    const polls = { count: 0 };
    const fake = await fakeProxy((seen) => {
      if (seen.url === ROUTES.open) {
        return { status: 200, body: { ok: true, flow: "f1", port: pi.port, path: "/callback" } };
      }

      polls.count += 1;

      return polls.count === 1
        ? { status: CALLBACK_STATUS.pending }
        : { status: CALLBACK_STATUS.ready, body: { query: "code=pi-sandbox-code-1&state=s1" } };
    });
    const result = await runShim([AUTHORIZE], fake.proxy);

    expect(result.code).toBe(0);
    expect(fake.seen.map((seen) => `${seen.method} ${seen.url}`)).toEqual([
      `POST ${ROUTES.open}`,
      `GET ${ROUTES.callback}?flow=f1`,
      `GET ${ROUTES.callback}?flow=f1`,
    ]);
    expect(JSON.parse(fake.seen[0]?.body ?? "{}")).toEqual({ url: AUTHORIZE });
    expect(fake.seen.every((seen) => seen.authorization === BASIC)).toBe(true);
    expect(pi.seen).toEqual(["/callback?code=pi-sandbox-code-1&state=s1"]);
  });

  it("cancels the flow when pi's listener is gone", async () => {
    const port = await closedPort();
    const fake = await fakeProxy((seen) =>
      seen.url === ROUTES.open
        ? { status: 200, body: { ok: true, flow: "f2", port, path: "/callback" } }
        : { status: seen.method === "POST" ? 200 : CALLBACK_STATUS.pending, body: { ok: true } },
    );
    const result = await runShim([AUTHORIZE], fake.proxy);

    expect(result.code).toBe(0);
    expect(fake.seen.map((seen) => `${seen.method} ${seen.url}`)).toEqual([
      `POST ${ROUTES.open}`,
      `GET ${ROUTES.callback}?flow=f2`,
      `POST ${ROUTES.cancel}?flow=f2`,
    ]);
  });

  it("exits 3 for anything but one https URL, without calling the proxy", async () => {
    const fake = await fakeProxy(() => ({ status: 500 }));
    const results = await Promise.all([
      runShim(["http://auth.vault.example/authorize"], fake.proxy),
      runShim([AUTHORIZE, AUTHORIZE], fake.proxy),
      runShim(["/etc/passwd"], fake.proxy),
      runShim([], fake.proxy),
    ]);

    expect(results.map((result) => result.code)).toEqual([3, 3, 3, 3]);
    expect(fake.seen).toEqual([]);
  });

  it("prints the proxy's refusal and exits 1", async () => {
    const fake = await fakeProxy(() => ({ status: 403, body: { error: "pi-sandbox: host not allowed" } }));
    const result = await runShim([AUTHORIZE], fake.proxy);

    expect(result).toMatchObject({ code: 1, stderr: "pi-sandbox: host not allowed\n" });
  });

  it("exits 1 when the flow is gone", async () => {
    const pi = await fakePi();
    const fake = await fakeProxy((seen) =>
      seen.url === ROUTES.open
        ? { status: 200, body: { ok: true, flow: "f3", port: pi.port, path: "/callback" } }
        : { status: CALLBACK_STATUS.gone, body: { error: "sign-in expired" } },
    );
    const result = await runShim([AUTHORIZE], fake.proxy);

    expect(result).toMatchObject({ code: 1, stderr: "pi-sandbox: sign-in expired\n" });
    expect(pi.seen).toEqual([]);
  });

  it("checks the proxy health with the sandbox credentials", async () => {
    const fake = await fakeProxy(() => ({ status: 200, body: { ok: true } }));
    const result = await runShim([CHECK_FLAG], fake.proxy);

    expect(result.code).toBe(0);
    expect(fake.seen.map((seen) => [seen.method, seen.url, seen.authorization])).toEqual([
      ["GET", HEALTH_ROUTE, BASIC],
    ]);
  });

  it("fails clearly without HTTPS_PROXY", async () => {
    const result = await runShim([AUTHORIZE]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^pi-sandbox: HTTPS_PROXY is not set/);
  });
});
