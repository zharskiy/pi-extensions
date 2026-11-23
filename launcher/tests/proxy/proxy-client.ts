import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { connectWithPreamble } from "../../proxy/preamble.ts";
import { TEST_TOKEN } from "./harness.ts";

export interface ConnectReply {
  status: number;
  head: string;
  socket: Socket;
}

const HEAD_END = "\r\n\r\n";

export const authorization = (token: string, user = "pi-sandbox") =>
  `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

export type PreambleToken = string | null;

const openProxySocket = (proxyPort: number, token: PreambleToken = TEST_TOKEN) =>
  token === null
    ? connect({ host: "127.0.0.1", port: proxyPort })
    : connectWithPreamble("127.0.0.1", proxyPort, token);

const headerLines = (headers: Record<string, string>) =>
  Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");

export const openConnectWith = (
  proxyPort: number,
  authority: string,
  headers: Record<string, string>,
  token?: PreambleToken,
) =>
  new Promise<ConnectReply>((resolve, reject) => {
    const socket = openProxySocket(proxyPort, token);
    const state = { buffer: Buffer.alloc(0) };

    const onData = (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);

      const text = state.buffer.toString("latin1");
      const end = text.indexOf(HEAD_END);

      if (end === -1) {
        return;
      }

      socket.off("data", onData);

      socket.pause();

      const rest = state.buffer.subarray(end + HEAD_END.length);

      if (rest.length > 0) {
        socket.unshift(rest);
      }

      resolve({ status: Number(text.split(" ")[1]), head: text.slice(0, end), socket });
    };

    socket.on("data", onData);

    socket.once("error", reject);

    socket.once("close", () => reject(new Error("the proxy closed the connection")));

    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${headerLines(headers)}\r\n`);
  });

export const openConnect = (proxyPort: number, authority: string, token?: PreambleToken) =>
  openConnectWith(proxyPort, authority, {}, token);

export const readRest = (socket: Socket) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];

    socket.on("data", (chunk: Buffer) => chunks.push(chunk));

    socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));

    socket.resume();
  });

export const secureTunnel = async (
  proxyPort: number,
  authority: string,
  servername: string,
  ca: string,
  token?: PreambleToken,
) => {
  const reply = await openConnect(proxyPort, authority, token);

  return new Promise<TLSSocket>((resolve, reject) => {
    const secure = tlsConnect({ socket: reply.socket, servername, ca, ALPNProtocols: ["http/1.1"] }, () =>
      resolve(secure),
    );

    secure.once("error", reject);
  });
};

export interface TunnelRequest {
  proxyPort: number;
  host: string;
  ca: string;
  path: string;
  port?: number;
  headers?: Record<string, string>;
  token?: PreambleToken;
  method?: string;
  body?: string;
}

export const requestThrough = async (options: TunnelRequest) => {
  const secure = await secureTunnel(
    options.proxyPort,
    `${options.host}:${options.port ?? 443}`,
    options.host,
    options.ca,
    options.token,
  );

  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(
      {
        host: options.host,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers,
        createConnection: () => secure,
      },
      resolve,
    );

    request.once("error", reject);

    request.end(options.body);
  });
};

export const readBody = (response: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];

    response.on("data", (chunk: Buffer) => chunks.push(chunk));

    response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

export interface PlainOptions {
  host?: string;
  token?: PreambleToken;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export const plainRequest = (proxyPort: number, path: string, options: PlainOptions = {}) =>
  new Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }>((resolve, reject) => {
    const host = options.host ?? "127.0.0.1";
    const request = httpRequest(
      {
        path,
        method: options.method ?? "GET",
        headers: { ...options.headers, host },
        createConnection: () => openProxySocket(proxyPort, options.token),
      },
      (response) => {
        void readBody(response).then((body) =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      },
    );

    request.once("error", reject);

    request.end(options.body);
  });

export const plainGet = (proxyPort: number, path: string, host = "127.0.0.1", token?: PreambleToken) =>
  plainRequest(proxyPort, path, { host, token });

export interface PageReply {
  connect: number;
  status: number;
  contentType?: string;
  body: string;
}

const secureOver = (socket: Socket, servername: string, ca: string | undefined) =>
  new Promise<TLSSocket>((resolve, reject) => {
    const secure = tlsConnect(
      { socket, servername, ca, rejectUnauthorized: ca !== undefined, ALPNProtocols: ["http/1.1"] },
      () => resolve(secure),
    );

    secure.once("error", reject);
  });

export const pageThrough = async (
  proxyPort: number,
  authority: string,
  token: string,
  ca?: string,
): Promise<PageReply> => {
  const reply = await openConnect(proxyPort, authority, token);

  if (reply.status !== 200) {
    return { connect: reply.status, status: reply.status, body: await readRest(reply.socket) };
  }

  const host = authority.replace(/:\d+$/, "");
  const secure = await secureOver(reply.socket, host, ca);
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpsRequest({ host, path: "/", createConnection: () => secure }, resolve);

    request.once("error", reject);

    request.end();
  });

  return {
    connect: 200,
    status: response.statusCode ?? 0,
    contentType: response.headers["content-type"],
    body: await readBody(response),
  };
};
