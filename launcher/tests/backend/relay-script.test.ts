import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { preambleText } from "../../proxy/index.ts";
import { startTestRelay, TEST_TOKEN } from "../proxy/harness.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const startUpstream = async () => {
  const connections: Array<{ socket: Socket; received: Buffer[] }> = [];
  const server: Server = createServer((socket) => {
    const connection = { socket, received: [] as Buffer[] };

    connections.push(connection);

    socket.on("data", (chunk: Buffer) => connection.received.push(chunk));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  cleanups.push(async () => {
    connections.forEach((connection) => {
      connection.socket.destroy();
    });

    await new Promise((resolve) => server.close(resolve));
  });

  const { port } = server.address() as AddressInfo;
  const texts = () => connections.map((connection) => Buffer.concat(connection.received).toString("utf8"));

  return { port, connections, texts };
};

const relayOn = async (upstreamPort: number, clientSubnet: string) => {
  const relay = await startTestRelay(upstreamPort, TEST_TOKEN, clientSubnet);

  cleanups.push(relay.close);

  return relay;
};

const exchange = (port: number, payload: string) =>
  new Promise<{ answer: string; closed: boolean }>((resolve) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (closed: boolean) => {
      socket.destroy();

      resolve({ answer: Buffer.concat(chunks).toString("utf8"), closed });
    };
    const timer = setTimeout(() => finish(false), 500);

    socket.on("connect", () => socket.write(payload));

    socket.on("data", (chunk: Buffer) => chunks.push(chunk));

    socket.on("close", () => {
      clearTimeout(timer);

      finish(true);
    });

    socket.on("error", () => undefined);
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("relay script", () => {
  it("drops a client outside the network's subnet before it opens an upstream connection", async () => {
    const upstream = await startUpstream();
    const relay = await relayOn(upstream.port, "10.89.0.0/24");
    const outcome = await exchange(relay.port, "GET /healthz HTTP/1.1\r\n\r\n");

    await settle();

    expect(outcome).toEqual({ answer: "", closed: true });
    expect(upstream.connections).toHaveLength(0);
  });

  it("serves a client inside the subnet, writing the preamble upstream ahead of the client's bytes", async () => {
    const upstream = await startUpstream();
    const relay = await relayOn(upstream.port, "127.0.0.0/8");

    await exchange(relay.port, "hello");

    await settle();

    expect(upstream.texts()).toContain(`${preambleText(TEST_TOKEN)}\nhello`);
  });
});
