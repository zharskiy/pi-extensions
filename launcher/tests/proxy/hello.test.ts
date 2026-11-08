import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addGrant } from "../../grants/index.ts";
import { createDialer } from "../../proxy/dial.ts";
import { createStateDir, removeDir, resolveTo, startTestProxy, type TestProxy, waitFor } from "./harness.ts";
import { openConnect, readRest } from "./proxy-client.ts";

const REPO = "1".repeat(64);

const state: { stateDir: string; recorder: Server; received: Buffer[]; test: TestProxy; token: string } = {
  stateDir: "",
  recorder: undefined as unknown as Server,
  received: [],
  test: undefined as unknown as TestProxy,
  token: "",
};

const portOf = (server: Server) => (server.address() as AddressInfo).port;

const listen = (server: Server) =>
  new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

const captureHello = async (servername: string) => {
  const capture = createServer();

  await listen(capture);

  const hello = new Promise<Buffer>((resolve) => {
    capture.once("connection", (socket: Socket) => {
      socket.once("data", (chunk: Buffer) => {
        socket.destroy();

        resolve(chunk);
      });
    });
  });
  const client = tlsConnect({ host: "127.0.0.1", port: portOf(capture), servername });

  client.on("error", () => undefined);

  const bytes = await hello;

  client.destroy();

  await new Promise<void>((resolve) => capture.close(() => resolve()));

  return bytes;
};

const receivedBytes = () => Buffer.concat(state.received);

beforeAll(async () => {
  state.stateDir = await createStateDir();
  state.recorder = createServer((socket) => {
    socket.on("data", (chunk: Buffer) => state.received.push(chunk));
  });

  await listen(state.recorder);

  state.test = await startTestProxy({
    stateDir: state.stateDir,
    policy: { allow: ["target.test"] },
    ports: () => ({ "target.test:443": portOf(state.recorder), "granted.test:443": portOf(state.recorder) }),
  });
  state.token = await state.test.tokenOf(REPO);
});

afterAll(async () => {
  await state.test?.proxy.close();

  await new Promise<void>((resolve) => state.recorder.close(() => resolve()));

  await removeDir(state.stateDir);
});

const tunnelTo = async (authority: string) => {
  const reply = await openConnect(state.test.proxy.port, authority, state.token);

  expect(reply.status).toBe(200);

  return reply.socket;
};

describe("ClientHello on a tunnel", () => {
  it("reassembles a hello split across two writes and forwards it whole", async () => {
    const hello = await captureHello("target.test");
    const socket = await tunnelTo("target.test:443");

    state.received = [];

    socket.write(hello.subarray(0, 20));

    await new Promise((resolve) => setTimeout(resolve, 50));

    socket.write(hello.subarray(20));

    await waitFor(() => (receivedBytes().length >= hello.length ? true : undefined));

    expect(receivedBytes().equals(hello)).toBe(true);

    socket.destroy();

    expect(
      await waitFor(() =>
        state.test.log.find((entry) => entry.decision === "allow" && entry.sni === "target.test"),
      ),
    ).toMatchObject({ host: "target.test", rule: "egress.allow", bytesOut: hello.length, repo: REPO });
  });

  it("records an sni denial when no hello arrives in time", async () => {
    const socket = await tunnelTo("target.test:443");
    const started = Date.now();

    await readRest(socket);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(
      state.test.log.find(
        (entry) => entry.decision === "deny" && entry.rule === "sni" && entry.host === "target.test",
      ),
    ).toMatchObject({ reason: "no TLS server name", repo: REPO });
  });

  it("refuses a hello whose server name differs from the CONNECT host", async () => {
    const hello = await captureHello("other.test");
    const socket = await tunnelTo("target.test:443");
    const closed = readRest(socket);

    socket.write(hello);

    await closed;

    expect(state.test.log).toContainEqual(
      expect.objectContaining({
        decision: "deny",
        rule: "sni",
        sni: "other.test",
        reason: "TLS server name other.test does not match target.test",
      }),
    );
  });

  it("forwards the hello of a host reachable only through a grant", async () => {
    await addGrant(state.stateDir, { host: "granted.test", port: 443, repoHash: REPO }, true, Date.now());

    const hello = await captureHello("granted.test");
    const socket = await tunnelTo("granted.test:443");

    state.received = [];

    socket.write(hello);

    await waitFor(() => (receivedBytes().length >= hello.length ? true : undefined));

    expect(receivedBytes().equals(hello)).toBe(true);

    socket.destroy();
  });
});

describe("upstream that never accepts the connection", () => {
  const local: { test?: TestProxy; stateDir: string } = { stateDir: "" };

  beforeAll(async () => {
    local.stateDir = await createStateDir();
    local.test = await startTestProxy({
      stateDir: local.stateDir,
      policy: { allow: ["slow.test"] },
      privateHosts: ["slow.test"],
      dial: createDialer({ resolve: resolveTo({ "slow.test": "192.0.2.1" }), connectTimeoutMs: 200 }),
    });
  });

  afterAll(async () => {
    await local.test?.proxy.close();

    await removeDir(local.stateDir);
  });

  it("gives up on the dial and records an upstream denial", async () => {
    const hello = await captureHello("slow.test");
    const reply = await openConnect(
      local.test?.proxy.port ?? 0,
      "slow.test:443",
      await local.test?.tokenOf(REPO),
    );
    const started = Date.now();
    const closed = readRest(reply.socket);

    reply.socket.write(hello);

    await closed;

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(
      local.test?.log.find((entry) => entry.host === "slow.test" && entry.decision === "deny"),
    ).toMatchObject({ rule: "upstream", reason: expect.stringMatching(/in time|UNREACH/) });
  });
});
