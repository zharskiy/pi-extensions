import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";

export interface ConnectReply {
  status: number;
  head: string;
  socket: Socket;
}

const HEAD_END = "\r\n\r\n";

const authorization = (token: string) => `Basic ${Buffer.from(`pi-sandbox:${token}`).toString("base64")}`;

const authLine = (token: string | undefined) =>
  token === undefined ? "" : `Proxy-Authorization: ${authorization(token)}\r\n`;

export const openConnect = (proxyPort: number, authority: string, token?: string) =>
  new Promise<ConnectReply>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: proxyPort });
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

    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authLine(token)}\r\n`);
  });

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
  token?: string,
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
  token?: string;
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
        headers: options.headers,
        createConnection: () => secure,
      },
      resolve,
    );

    request.once("error", reject);

    request.end();
  });
};

export const readBody = (response: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];

    response.on("data", (chunk: Buffer) => chunks.push(chunk));

    response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

export const plainGet = (proxyPort: number, path: string, host = "127.0.0.1", token?: string) =>
  new Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path,
        headers: token === undefined ? { host } : { host, "proxy-authorization": authorization(token) },
      },
      (response) => {
        void readBody(response).then((body) =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      },
    );

    request.once("error", reject);

    request.end();
  });
