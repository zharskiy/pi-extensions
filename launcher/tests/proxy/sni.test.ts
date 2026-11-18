import { createServer, type Socket } from "node:net";
import { connect } from "node:tls";
import { describe, expect, it } from "vitest";
import { parseServerName } from "../../proxy/sni.ts";

const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);

const u24 = (value: number) => Buffer.from([value >> 16, (value >> 8) & 0xff, value & 0xff]);

const vector16 = (body: Buffer) => Buffer.concat([u16(body.length), body]);

const extension = (type: number, body: Buffer) => Buffer.concat([u16(type), vector16(body)]);

const serverName = (name: string) =>
  extension(0, vector16(Buffer.concat([Buffer.from([0]), vector16(Buffer.from(name, "ascii"))])));

const clientHello = (extensions: Buffer[]) => {
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    vector16(Buffer.from([0x13, 0x01])),
    Buffer.from([1, 0]),
    vector16(Buffer.concat(extensions)),
  ]);
  const handshake = Buffer.concat([Buffer.from([0x01]), u24(body.length), body]);

  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(handshake.length), handshake]);
};

const captureClientHello = (servername: string) =>
  new Promise<Buffer>((resolve) => {
    const server = createServer((socket: Socket) => {
      socket.once("data", (chunk: Buffer) => {
        resolve(chunk);

        socket.destroy();

        server.close();
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const client = connect({ host: "127.0.0.1", port, servername });

      client.on("error", () => undefined);
    });
  });

describe("parseServerName", () => {
  it("reads the server name after other extensions", () => {
    const hello = clientHello([
      extension(0x000a, Buffer.from([0, 2, 0, 0x1d])),
      serverName("api.example.com"),
    ]);

    expect(parseServerName(hello)).toBe("api.example.com");
  });

  it("returns undefined without a server name extension", () => {
    expect(parseServerName(clientHello([extension(0x000a, Buffer.from([0, 2, 0, 0x1d]))]))).toBeUndefined();
  });

  it("returns undefined for truncated or non-TLS input", () => {
    const hello = clientHello([serverName("api.example.com")]);

    expect(parseServerName(hello.subarray(0, hello.length - 4))).toBeUndefined();

    expect(parseServerName(Buffer.from("GET / HTTP/1.1\r\n\r\n"))).toBeUndefined();

    expect(parseServerName(Buffer.alloc(0))).toBeUndefined();
  });

  it("reads the server name from a ClientHello sent by node:tls", async () => {
    expect(parseServerName(await captureClientHello("captured.example.org"))).toBe("captured.example.org");
  });
});
