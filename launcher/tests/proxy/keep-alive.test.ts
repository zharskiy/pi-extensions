import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import { connect, type Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import { createDialer } from "../../proxy/dial.ts";
import { parentRouteFor } from "../../proxy/parent.ts";
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
} from "./harness.ts";
import { secureTunnel } from "./proxy-client.ts";

const HOST = "api.test";

const RULES: CredentialRule[] = [
  { id: "api", host: HOST, placeholder: "pi-sandbox-0123456789abcdef01234567", secret: { env: "API" } },
];

const state: {
  stateDir: string;
  ca: LauncherCa;
  upstream: Server;
  parent: HttpServer;
  connections: number;
  parentConnects: number;
  proxies: TestProxy[];
} = {
  stateDir: "",
  ca: undefined as unknown as LauncherCa,
  upstream: undefined as unknown as Server,
  parent: undefined as unknown as HttpServer,
  connections: 0,
  parentConnects: 0,
  proxies: [],
};

beforeAll(async () => {
  state.stateDir = await createStateDir();
  state.ca = await openCa(state.stateDir);
  state.upstream = createHttpsServer(await state.ca.leaf(HOST), (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain", "content-length": "2" });

    response.end("ok");
  });

  state.upstream.on("secureConnection", () => {
    state.connections += 1;
  });

  await listen(state.upstream);

  state.parent = createHttpServer();

  state.parent.on("connect", (_request, socket: Socket) => {
    state.parentConnects += 1;

    const upstream = connect({ host: "127.0.0.1", port: portOf(state.upstream) });

    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      socket.pipe(upstream).pipe(socket);
    });

    upstream.on("error", () => socket.destroy());

    socket.on("error", () => upstream.destroy());
  });

  await listen(state.parent as unknown as Server);
}, 30_000);

afterEach(async () => {
  await Promise.all(state.proxies.splice(0).map((test) => test.proxy.close()));

  state.connections = 0;

  state.parentConnects = 0;
});

afterAll(async () => {
  await closeServer(state.upstream);

  state.parent.closeAllConnections();

  await new Promise<void>((resolve) => state.parent.close(() => resolve()));

  await removeDir(state.stateDir);
});

const proxyWith = async (dial?: ReturnType<typeof createDialer>) => {
  const test = await startTestProxy({
    stateDir: state.stateDir,
    policy: { allow: [HOST] },
    ca: state.ca,
    rules: RULES,
    resolver: fakeResolver({ api: "secret" }).resolver,
    ports: () => ({ [`${HOST}:443`]: portOf(state.upstream) }),
    dial,
  });

  state.proxies.push(test);

  return test;
};

const viaParent = () =>
  createDialer({
    parent: parentRouteFor({
      HTTPS_PROXY: `http://127.0.0.1:${portOf(state.parent as unknown as Server)}`,
    }),
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  });

const exchange = (secure: TLSSocket, path: string) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);

      const text = Buffer.concat(chunks).toString("utf8");

      if (text.endsWith("\r\n\r\nok")) {
        secure.off("data", onData);

        resolve(text);
      }
    };

    secure.on("data", onData);

    secure.write(`GET ${path} HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`);
  });

const tunnelFor = (test: TestProxy) =>
  secureTunnel(test.proxy.port, `${HOST}:443`, HOST, state.ca.certPem, test.token);

const twoRequests = async (test: TestProxy) => {
  const one = await tunnelFor(test);

  await exchange(one, "/one");

  await exchange(one, "/two");

  one.destroy();
};

describe("upstream connections of a terminated host", () => {
  it("reuses one upstream connection for two requests on one client connection", async () => {
    await twoRequests(await proxyWith());

    expect(state.connections).toBe(1);
  });

  it("reuses the parent tunnel within one repository", async () => {
    await twoRequests(await proxyWith(viaParent()));

    expect([state.parentConnects, state.connections]).toEqual([1, 1]);
  });
});
