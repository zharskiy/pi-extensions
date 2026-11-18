import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { TestCertificate } from "./test-ca.ts";

export interface SeenRequest {
  host: string;
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
  raw: Buffer;
}

export type FixtureHandler = (request: SeenRequest, response: ServerResponse) => void | Promise<void>;

export interface HttpsFixture {
  port: number;
  seen: SeenRequest[];
  url(host: string, path?: string): string;
  close(): Promise<void>;
}

const bodyOf = (request: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));

    request.once("end", () => resolve(Buffer.concat(chunks)));

    request.once("error", reject);
  });

export const sendJson = (response: ServerResponse, status: number, value: unknown, headers = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });

  response.end(JSON.stringify(value));
};

const hostOf = (request: IncomingMessage) => (request.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();

const serve =
  (handler: FixtureHandler, seen: SeenRequest[]) =>
  async (request: IncomingMessage, response: ServerResponse) => {
    const raw = await bodyOf(request);
    const seenRequest: SeenRequest = {
      host: hostOf(request),
      method: request.method ?? "GET",
      path: request.url ?? "/",
      headers: request.headers,
      body: raw.toString("utf8"),
      raw,
    };

    seen.push(seenRequest);

    await Promise.resolve(handler(seenRequest, response)).catch((error: unknown) => {
      sendJson(response, 500, { error: String(error) });
    });
  };

const listening = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

export const startHttpsFixture = async (
  certificate: TestCertificate,
  handler: FixtureHandler,
): Promise<HttpsFixture> => {
  const seen: SeenRequest[] = [];
  const server = createServer({ key: certificate.key, cert: certificate.cert }, serve(handler, seen));
  const port = await listening(server);

  return {
    port,
    seen,
    url: (host, path = "/") => `https://${host}:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();

        server.close(() => resolve());
      }),
  };
};
