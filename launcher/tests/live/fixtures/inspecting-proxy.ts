import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createSecureContext, type SecureContext, TLSSocket, connect as tlsConnect } from "node:tls";
import type { TestCa, TestCertificate } from "./test-ca.ts";

export interface InspectedTunnel {
  host: string;
  port: number;
  authorized: boolean;
}

export interface InspectingProxy {
  port: number;
  url: string;
  tunnels: InspectedTunnel[];
  close(): Promise<void>;
}

export interface InspectingProxyOptions {
  ca: TestCa;
  upstreamCa: string;
  credentials: { user: string; password: string };
  resolve: (host: string) => string;
}

const ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";

const REQUIRED =
  'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="parent"\r\nContent-Length: 0\r\n\r\n';

const targetOf = (request: IncomingMessage) => {
  const [host = "", port = "443"] = (request.url ?? "").split(":");

  return { host: host.toLowerCase(), port: Number(port) };
};

const interceptTls = (client: Socket, context: SecureContext, upstream: () => TLSSocket) => {
  const secure = new TLSSocket(client, {
    isServer: true,
    secureContext: context,
    ALPNProtocols: ["http/1.1"],
  });

  secure.on("error", () => client.destroy());

  secure.once("secure", () => {
    const remote = upstream();

    remote.on("error", () => secure.destroy());

    secure.pipe(remote).pipe(secure);

    secure.once("close", () => remote.destroy());

    remote.once("close", () => secure.destroy());
  });
};

export const startInspectingProxy = async (options: InspectingProxyOptions): Promise<InspectingProxy> => {
  const expected = `Basic ${Buffer.from(`${options.credentials.user}:${options.credentials.password}`).toString("base64")}`;
  const certificates = new Map<string, Promise<TestCertificate>>();
  const tunnels: InspectedTunnel[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((_, response) => {
    response.writeHead(405);

    response.end();
  });

  const certificateFor = (host: string) => {
    const known = certificates.get(host) ?? options.ca.issue([host]);

    certificates.set(host, known);

    return known;
  };

  server.on("connect", async (request: IncomingMessage, client: Socket, head: Buffer) => {
    const target = targetOf(request);
    const authorized = request.headers["proxy-authorization"] === expected;

    sockets.add(client);

    client.once("close", () => sockets.delete(client));

    client.on("error", () => client.destroy());

    tunnels.push({ ...target, authorized });

    if (!authorized) {
      client.end(REQUIRED);

      return;
    }

    const context = createSecureContext(await certificateFor(target.host));

    client.write(ESTABLISHED);

    if (head.length > 0) {
      client.unshift(head);
    }

    interceptTls(client, context, () =>
      tlsConnect({
        host: options.resolve(target.host),
        port: target.port,
        servername: target.host,
        ca: options.upstreamCa,
        ALPNProtocols: ["http/1.1"],
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    tunnels,
    close: () =>
      new Promise<void>((resolve) => {
        sockets.forEach((socket) => {
          socket.destroy();
        });

        server.close(() => resolve());
      }),
  };
};
