import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const FORWARDER = fileURLToPath(new URL("../../image/forwarder.mjs", import.meta.url));

const addresses = Object.values(networkInterfaces()).flatMap((entries) => entries ?? []);

const hasIpv6Loopback = addresses.some((entry) => entry.address === "::1");

const upstreamHost = addresses.find((entry) => entry.family === "IPv4" && !entry.internal)?.address;

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => {
    cleanup();
  });
});

const listening = (server: net.Server, host: string, port = 0) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);

    server.listen({ host, port }, () => resolve((server.address() as net.AddressInfo).port));
  });

const echoUpstream = async (host: string) => {
  const accepted: net.Socket[] = [];
  const server = net.createServer((socket) => {
    accepted.push(socket);

    socket.pipe(socket);
  });
  const port = await listening(server, host);

  cleanups.push(() => server.close());

  return { port, accepted };
};

const exitOf = (child: ChildProcess) => new Promise<number | null>((resolve) => child.on("exit", resolve));

const statusOf = async (path: string): Promise<string> => {
  const text = await readFile(path, "utf8").catch(() => undefined);

  if (text !== undefined) {
    return text;
  }

  await new Promise((resolve) => setTimeout(resolve, 20));

  return statusOf(path);
};

const startForwarder = async (host: string, ports: number[]) => {
  const status = join(await mkdtemp(join(tmpdir(), "forwarder-")), "status");
  const child = spawn(process.execPath, [FORWARDER, status, host, ...ports.map(String)], { stdio: "ignore" });
  const exited = exitOf(child);

  cleanups.push(() => child.kill());

  return { status: await statusOf(status), exited };
};

const roundTrip = (host: string, port: number) =>
  new Promise<string>((resolve, reject) => {
    const socket = net.connect({ host, port }, () => socket.end("ping"));
    const chunks: Buffer[] = [];

    socket.on("data", (chunk: Buffer) => chunks.push(chunk));

    socket.on("end", () => resolve(Buffer.concat(chunks).toString()));

    socket.on("error", reject);
  });

describe("the services forwarder", () => {
  it.skipIf(upstreamHost === undefined || !hasIpv6Loopback)(
    "forwards each connection on 127.0.0.1 and ::1 to the same port of the services host, one upstream per connection",
    async () => {
      const upstream = await echoUpstream(upstreamHost ?? "");
      const forwarder = await startForwarder(upstreamHost ?? "", [upstream.port]);

      expect(forwarder.status).toBe("");
      expect(await roundTrip("127.0.0.1", upstream.port)).toBe("ping");
      expect(await roundTrip("::1", upstream.port)).toBe("ping");
      expect(await roundTrip("127.0.0.1", upstream.port)).toBe("ping");
      expect(upstream.accepted).toHaveLength(3);
    },
  );

  it("fails and names the port when it cannot listen on it", async () => {
    const taken = net.createServer();
    const port = await listening(taken, "127.0.0.1");

    cleanups.push(() => taken.close());

    const forwarder = await startForwarder("127.0.0.1", [port]);

    expect(forwarder.status).toContain(`port ${port} on 127.0.0.1`);
    expect(await forwarder.exited).toBe(1);
  });

  it.skipIf(upstreamHost === undefined || !hasIpv6Loopback)(
    "closes the client when nothing listens on the services host",
    async () => {
      const probe = net.createServer();
      const port = await listening(probe, "127.0.0.1");

      await new Promise((resolve) => probe.close(resolve));

      const forwarder = await startForwarder(upstreamHost ?? "", [port]);

      expect(forwarder.status).toBe("");
      expect(await roundTrip("127.0.0.1", port).catch(() => "closed")).toMatch(/^(closed|)$/);
    },
  );
});
