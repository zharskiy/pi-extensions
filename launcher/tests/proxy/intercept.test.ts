import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessLogEntry } from "../../proxy/access-log.ts";
import { createDenialPages } from "../../proxy/denial-page.ts";
import { createDenials, type RecordAccess } from "../../proxy/denials.ts";
import { createInterceptor, handshakeDenial } from "../../proxy/intercept.ts";
import { type LauncherCa, type LeafCertificate, openLauncherCa } from "../../proxy/tls-ca.ts";
import { createProcessRunner } from "../../shared/index.ts";

const HOST = "intercept.test";

const HELLO_TIMEOUT_MS = 60_000;

type Entry = Omit<AccessLogEntry, "time" | "user" | "repo">;

const state: { stateDir: string; ca?: LauncherCa } = { stateDir: "" };

beforeAll(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-intercept-"));

  state.ca = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });
});

afterAll(async () => {
  await rm(state.stateDir, { recursive: true, force: true });
});

const LEFT = "the client closed the connection before its TLS hello";

interface ProxyOptions {
  helloTimeoutMs?: number;
  leaf?: (host: string) => Promise<LeafCertificate>;
}

const captureClientHello = (servername: string) =>
  new Promise<Buffer>((resolve) => {
    const server = createNetServer((socket) => {
      socket.once("data", (chunk: Buffer) => {
        resolve(chunk);

        socket.destroy();

        server.close();
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const client = connectTls({
        host: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        servername,
      });

      client.on("error", () => undefined);
    });
  });

const startProxy = async (options: ProxyOptions = {}) => {
  const ca = state.ca as LauncherCa;
  const entries: Entry[] = [];
  const served: string[] = [];
  const closed: Array<Promise<void>> = [];
  const waiters: Array<(entry: Entry) => void> = [];

  const record: RecordAccess = (entry) => {
    entries.push(entry);

    waiters.splice(0).forEach((wake) => {
      wake(entry);
    });
  };

  const denials = createDenials(
    "1".repeat(64),
    record,
    createDenialPages({ leaf: (host) => ca.ephemeralLeaf(host) }),
  );

  const serve = (socket: TLSSocket) => {
    served.push(socket.servername || "");

    socket.resume();

    socket.end("ok");
  };

  const intercept = createInterceptor({
    ca: { leaf: options.leaf ?? ((host) => ca.leaf(host)) },
    helloTimeoutMs: options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    serve,
    record,
    denials,
  });
  const server: Server = createServer();

  server.on("connect", (_request, socket: Socket, head: Buffer) => {
    closed.push(new Promise((resolve) => socket.once("close", () => resolve())));

    void intercept({ host: HOST, port: 443, access: "public", client: socket }, head);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  const nextEntry = () => new Promise<Entry>((resolve) => waiters.push(resolve));

  const open = () => {
    const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");

    socket.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`);

    return socket;
  };

  const tunnel = async () => {
    const socket = open();

    const reply = await new Promise<string>((resolve) =>
      socket.once("data", (chunk: Buffer) => resolve(String(chunk))),
    );

    expect(reply).toMatch(/^HTTP\/1\.1 200/);

    return socket;
  };

  const stop = () => new Promise<void>((resolve) => server.close(() => resolve()));

  return { entries, served, closed, denials, nextEntry, open, tunnel, stop };
};

describe("TLS interception", () => {
  it("records a client that rejects the leaf as soon as it closes", async () => {
    const proxy = await startProxy();
    const recorded = proxy.nextEntry();
    const socket = await proxy.tunnel();
    const client = connectTls({ socket, servername: HOST });

    client.on("error", () => undefined);

    const entry = await recorded;

    await Promise.all(proxy.closed);

    expect(entry).toMatchObject({ host: HOST, sni: HOST, decision: "deny", rule: "tls" });
    expect(proxy.denials.since(0)).toEqual([
      expect.objectContaining({
        host: HOST,
        port: 443,
        rule: "tls",
        reason:
          "the client closed the connection during the TLS handshake, so it may not trust the launcher CA or the VM's clock may be more than an hour behind the host's",
      }),
    ]);

    await proxy.stop();
  });

  it("serves a trusting client that writes and ends without noting a denial", async () => {
    const proxy = await startProxy();
    const recorded = proxy.nextEntry();
    const socket = await proxy.tunnel();
    const client = connectTls({ socket, servername: HOST, ca: state.ca?.certPem });

    client.once("secureConnect", () => {
      client.end("hi");
    });

    client.resume();

    const entry = await recorded;

    expect(entry).toMatchObject({ host: HOST, sni: HOST, decision: "allow", rule: "terminate" });
    expect(proxy.served).toEqual([HOST]);
    expect(proxy.denials.since(0)).toEqual([]);

    await proxy.stop();
  });

  it("records a client that closes the tunnel before its TLS hello", async () => {
    const proxy = await startProxy();
    const recorded = proxy.nextEntry();
    const socket = await proxy.tunnel();

    socket.end();

    const entry = await recorded;

    expect(entry).toMatchObject({ host: HOST, decision: "deny", rule: "tls" });
    expect(proxy.denials.since(0)).toEqual([expect.objectContaining({ reason: LEFT })]);

    await proxy.stop();
  });

  it("records a client that resets the tunnel before its TLS hello as having left", async () => {
    const proxy = await startProxy();
    const recorded = proxy.nextEntry();
    const socket = await proxy.tunnel();

    socket.resetAndDestroy();

    const entry = await recorded;

    expect(entry).toMatchObject({ host: HOST, decision: "deny", rule: "tls", reason: LEFT });

    await proxy.stop();
  });

  it("keeps the missing server name for a client that stays silent until the hello timer", async () => {
    const proxy = await startProxy({ helloTimeoutMs: 50 });
    const recorded = proxy.nextEntry();
    const socket = await proxy.tunnel();

    socket.on("error", () => undefined);

    const entry = await recorded;

    expect(entry).toMatchObject({ host: HOST, decision: "deny", rule: "sni", reason: "no TLS server name" });

    await proxy.stop();
  });

  it("counts a hello that arrives while the leaf is being minted", async () => {
    const hello = await captureClientHello(HOST);
    const gate: { entered?: () => void; release?: () => void } = {};
    const entered = new Promise<void>((resolve) => {
      gate.entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      gate.release = resolve;
    });

    const leaf = async (host: string) => {
      gate.entered?.();

      await released;

      return (state.ca as LauncherCa).leaf(host);
    };

    const proxy = await startProxy({ leaf });
    const recorded = proxy.nextEntry();
    const socket = proxy.open();

    socket.on("error", () => undefined);

    await entered;

    await new Promise<void>((resolve) => socket.end(hello, () => resolve()));

    gate.release?.();

    const entry = await recorded;

    expect(entry).toMatchObject({ host: HOST, sni: HOST, decision: "deny", rule: "tls" });
    expect(entry.reason).not.toBe(LEFT);

    await proxy.stop();
  });

  it("does not take a hello without a server name for a client that left before its hello", async () => {
    const proxy = await startProxy();
    const recorded = proxy.nextEntry();
    const socket = await proxy.tunnel();
    const client = connectTls({ socket, host: "127.0.0.1" });

    client.on("error", () => undefined);

    const entry = await recorded;

    expect(entry).toMatchObject({ host: HOST, decision: "deny", rule: "sni" });
    expect(proxy.denials.since(0)).toEqual([
      expect.objectContaining({ rule: "sni", reason: "no TLS server name" }),
    ]);

    await proxy.stop();
  });
});

describe("handshakeDenial", () => {
  const REJECTED =
    "the client rejected the proxy's certificate, so it may not trust the launcher CA or the VM's clock may be more than an hour behind the host's";

  const named = { host: HOST, sni: HOST };

  it("names the CA and the clock for a certificate alert from the client", () => {
    [
      "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
      "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
      "ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED",
      "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
    ].forEach((errorCode) => {
      expect(handshakeDenial(named, { ended: false, silent: false, errorCode })).toEqual({
        rule: "tls",
        reason: REJECTED,
      });
    });
  });

  it("keeps the generic reason for other TLS errors and no error", () => {
    ["ERR_SSL_WRONG_VERSION_NUMBER", "ECONNRESET", undefined].forEach((errorCode) => {
      expect(handshakeDenial(named, { ended: false, silent: false, errorCode })).toEqual({
        rule: "tls",
        reason: "TLS handshake with the client failed",
      });
    });
  });

  it("says the client left only when it sent nothing and the hello timer did not fire", () => {
    expect(handshakeDenial({ host: HOST }, { ended: true, silent: true }).reason).toBe(LEFT);

    expect(
      handshakeDenial({ host: HOST }, { ended: false, silent: true, errorCode: "ECONNRESET" }).reason,
    ).toBe(LEFT);

    expect(handshakeDenial({ host: HOST }, { ended: false, silent: true, timedOut: true })).toMatchObject({
      rule: "sni",
      reason: "no TLS server name",
    });

    expect(handshakeDenial({ host: HOST }, { ended: true, silent: false })).toMatchObject({
      rule: "sni",
      reason: "no TLS server name",
    });

    expect(handshakeDenial(named, { ended: true, silent: false }).reason).toMatch(
      /^the client closed the connection during the TLS handshake/,
    );
  });

  it("puts a server name mismatch before the alert", () => {
    expect(
      handshakeDenial(
        { host: HOST, sni: "other.test" },
        { ended: false, silent: false, errorCode: "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA" },
      ).rule,
    ).toBe("sni");
  });
});
