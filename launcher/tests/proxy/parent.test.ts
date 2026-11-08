import { createServer, type Server } from "node:http";
import {
  type AddressInfo,
  connect,
  createServer as createTcpServer,
  type Socket,
  type Server as TcpServer,
} from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDialer, RestrictedAddressError } from "../../proxy/dial.ts";
import { basicAuthorization, bypassesParent, parentRouteFor } from "../../proxy/parent.ts";
import type { SecretResolver } from "../../proxy/secrets/index.ts";

const state: { parent: Server; echo: TcpServer; seen: Array<{ target?: string; auth?: string }> } = {
  parent: undefined as unknown as Server,
  echo: undefined as unknown as TcpServer,
  seen: [],
};

const portOf = (server: Server | TcpServer) => (server.address() as AddressInfo).port;

const listen = (server: Server | TcpServer) =>
  new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

const close = (server: Server | TcpServer | undefined) =>
  new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));

beforeAll(async () => {
  state.echo = createTcpServer((socket) => socket.pipe(socket));

  await listen(state.echo);

  state.parent = createServer();

  state.parent.on("connect", (request, socket: Socket) => {
    state.seen.push({ target: request.url, auth: request.headers["proxy-authorization"] });

    if (request.headers["proxy-authorization"] !== basicAuthorization("corp:pass")) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");

      return;
    }

    const upstream = connect({ host: "127.0.0.1", port: portOf(state.echo) });

    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      socket.pipe(upstream).pipe(socket);
    });
  });

  await listen(state.parent);
});

afterAll(async () => {
  state.parent?.closeAllConnections();

  await close(state.parent);

  await close(state.echo);
});

const resolverWith = (value: string | undefined): SecretResolver => ({
  resolve: async () => (value === undefined ? { ok: false, reason: "none" } : { ok: true, value }),
  invalidate: () => undefined,
});

const echoOnce = (socket: Socket, text: string) =>
  new Promise<string>((resolve) => {
    socket.once("data", (chunk: Buffer) => resolve(String(chunk)));

    socket.resume();

    socket.write(text);
  });

const publicResolve = async () => [{ address: "93.184.216.34", family: 4 }];

const loopbackSix = await new Promise<boolean>((resolve) => {
  const probe = createTcpServer();

  probe.once("error", () => resolve(false));

  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

describe("parent proxy", () => {
  it("dials a parent given as an IPv6 literal without its brackets", async () => {
    const route = parentRouteFor("env", { HTTPS_PROXY: "http://[::1]:3128" }, resolverWith(undefined));

    expect([route?.host, route?.port]).toEqual(["::1", 3128]);
  });

  it.skipIf(!loopbackSix)("tunnels through a parent listening on [::1]", async () => {
    const parent = createServer();

    parent.on("connect", (_request, socket: Socket) => {
      const upstream = connect({ host: "127.0.0.1", port: portOf(state.echo) });

      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

        socket.pipe(upstream).pipe(socket);
      });
    });

    await new Promise<void>((resolve) => parent.listen(0, "::1", () => resolve()));

    try {
      const route = parentRouteFor(
        "env",
        { HTTPS_PROXY: `http://[::1]:${portOf(parent)}` },
        resolverWith(undefined),
      );
      const socket = await createDialer({ parent: route, resolve: publicResolve })(
        "api.example.test",
        443,
        "public",
      );

      expect(await echoOnce(socket, "over six")).toBe("over six");

      socket.destroy();
    } finally {
      parent.closeAllConnections();

      await close(parent);
    }
  });

  it("tunnels through the parent with Basic auth from the secret", async () => {
    const route = parentRouteFor(
      "env",
      { HTTPS_PROXY: `http://127.0.0.1:${portOf(state.parent)}` },
      resolverWith("corp:pass"),
    );
    const socket = await createDialer({ parent: route, resolve: publicResolve })(
      "api.example.test",
      443,
      "public",
    );

    expect(await echoOnce(socket, "hello")).toBe("hello");
    expect(state.seen.at(-1)).toEqual({
      target: "api.example.test:443",
      auth: basicAuthorization("corp:pass"),
    });

    socket.destroy();
  });

  it("fails when the parent refuses the credentials", async () => {
    const route = parentRouteFor(
      "env",
      { HTTPS_PROXY: `http://127.0.0.1:${portOf(state.parent)}` },
      resolverWith(undefined),
    );

    await expect(
      createDialer({ parent: route, resolve: publicResolve })("api.example.test", 443, "public"),
    ).rejects.toThrow("407");
  });

  it("still refuses a name that resolves only to private addresses", async () => {
    const route = parentRouteFor(
      "env",
      { HTTPS_PROXY: `http://127.0.0.1:${portOf(state.parent)}` },
      resolverWith("corp:pass"),
    );
    const dial = createDialer({ parent: route, resolve: async () => [{ address: "10.0.0.5", family: 4 }] });

    await expect(dial("internal.example.test", 443, "public")).rejects.toBeInstanceOf(RestrictedAddressError);
  });

  it("lets the parent resolve a name the host cannot", async () => {
    const before = state.seen.length;
    const route = parentRouteFor(
      "env",
      { HTTPS_PROXY: `http://127.0.0.1:${portOf(state.parent)}` },
      resolverWith("corp:pass"),
    );
    const notFound = async () => {
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    };
    const socket = await createDialer({ parent: route, resolve: notFound })(
      "only-parent.test",
      443,
      "public",
    );

    expect(state.seen.length).toBe(before + 1);

    socket.destroy();
  });

  it("takes the env parent's address from HTTPS_PROXY and its credentials only from the launcher's memory copy", async () => {
    const env = {
      HTTPS_PROXY: `http://corp:pass@127.0.0.1:${portOf(state.parent)}`,
      NO_PROXY: "internal.test,.corp.test",
    };
    const sent = parentRouteFor("env", env, resolverWith("corp:sent-by-launcher"));
    const unsent = parentRouteFor("env", env, resolverWith(undefined));

    expect(sent?.noProxy).toEqual(["internal.test", ".corp.test"]);
    expect(sent?.port).toBe(portOf(state.parent));
    expect(await sent?.authorization()).toBe(basicAuthorization("corp:sent-by-launcher"));
    expect(await unsent?.authorization()).toBeUndefined();
    expect(parentRouteFor("none", { HTTPS_PROXY: "http://x:1" }, resolverWith(undefined))).toBeUndefined();
  });

  it("gives up on a parent that accepts the connection but never answers the CONNECT", async () => {
    const silent = createTcpServer((socket) => {
      socket.on("data", () => undefined);
    });

    await listen(silent);

    const route = parentRouteFor(
      "env",
      { HTTPS_PROXY: `http://127.0.0.1:${portOf(silent)}` },
      resolverWith(undefined),
    );
    const started = Date.now();
    const outcome = await createDialer({
      parent: route && { ...route, timeoutMs: 200 },
      resolve: publicResolve,
    })("api.example.test", 443, "public").catch((error: Error) => error.message);

    await close(silent);

    expect(outcome).toBe("the parent proxy did not answer in time");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("asks for the parent credentials of the repository that dials", async () => {
    const asked: Array<string | undefined> = [];
    const resolver: SecretResolver = {
      resolve: async (_key, _ref, repoHash) => {
        asked.push(repoHash);

        return repoHash === "a".repeat(64) ? { ok: true, value: "corp:pass" } : { ok: false, reason: "none" };
      },
      invalidate: () => undefined,
    };
    const route = parentRouteFor(
      "env",
      { HTTPS_PROXY: `http://127.0.0.1:${portOf(state.parent)}` },
      resolver,
    );
    const dial = createDialer({ parent: route, resolve: publicResolve });
    const socket = await dial("api.example.test", 443, "public", "a".repeat(64));
    const other = await dial("api.example.test", 443, "public", "b".repeat(64)).catch(
      (error: Error) => error,
    );

    socket.destroy();

    expect(asked).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(other).toBeInstanceOf(Error);
  });

  it("honours noProxy entries", () => {
    expect(bypassesParent(["internal.test"], "internal.test")).toBe(true);
    expect(bypassesParent([".corp.test"], "git.corp.test")).toBe(true);
    expect(bypassesParent(["*.corp.test"], "corp.test")).toBe(true);
    expect(bypassesParent(["*.corp.test"], "evilcorp.test")).toBe(false);
    expect(bypassesParent(["internal.test"], "api.internal.test")).toBe(false);
  });
});
