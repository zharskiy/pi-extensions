import { connect, type Socket } from "node:net";
import { normalizeHost, parentProxyOf } from "../config/index.ts";
import { CONNECT_TIMEOUT_MS, connected } from "./connect.ts";

export interface ParentRoute {
  host: string;
  port: number;
  noProxy: string[];
  authorization?: string;
  timeoutMs?: number;
}

const HEAD_END = "\r\n\r\n";

const MAX_HEAD_BYTES = 16_384;

export const basicAuthorization = (credentials: string) =>
  `Basic ${Buffer.from(credentials).toString("base64")}`;

const matchesNoProxy = (host: string, entry: string) => {
  const pattern = normalizeHost(entry);

  if (pattern === "*") {
    return true;
  }

  if (pattern.startsWith("*.") || pattern.startsWith(".")) {
    const suffix = pattern.startsWith("*.") ? pattern.slice(1) : pattern;

    return host.endsWith(suffix) || host === suffix.slice(1);
  }

  return host === pattern;
};

export const bypassesParent = (noProxy: string[], host: string) =>
  noProxy.some((entry) => entry.trim() !== "" && matchesNoProxy(normalizeHost(host), entry));

export const parentRouteFor = (env: Record<string, string | undefined>): ParentRoute | undefined => {
  const target = parentProxyOf(env);

  if (target === undefined || "unsupported" in target) {
    return undefined;
  }

  return {
    host: target.host,
    port: target.port,
    noProxy: target.noProxy,
    ...(target.credentials === undefined ? {} : { authorization: basicAuthorization(target.credentials) }),
  };
};

const readHead = (socket: Socket, timeoutMs: number) =>
  new Promise<string>((resolve, reject) => {
    const state = { buffer: Buffer.alloc(0) };

    const stop = () => {
      clearTimeout(timer);

      socket.off("data", onData);

      socket.off("error", onError);

      socket.off("close", onClose);
    };

    const onError = (error: Error) => {
      stop();

      reject(error);
    };

    const onClose = () => onError(new Error("the parent proxy closed the connection"));

    const onData = (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);

      const end = state.buffer.indexOf(HEAD_END);

      if (end === -1 && state.buffer.length < MAX_HEAD_BYTES) {
        return;
      }

      if (end === -1) {
        onError(new Error("the parent proxy sent an oversized response head"));

        return;
      }

      stop();

      socket.pause();

      const rest = state.buffer.subarray(end + HEAD_END.length);

      if (rest.length > 0) {
        socket.unshift(rest);
      }

      resolve(state.buffer.subarray(0, end).toString("latin1"));
    };

    const timer = setTimeout(() => onError(new Error("the parent proxy did not answer in time")), timeoutMs);

    socket.on("data", onData);

    socket.once("error", onError);

    socket.once("close", onClose);
  });

export const dialViaParent = async (parent: ParentRoute, host: string, port: number) => {
  const timeoutMs = parent.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const socket = await connected(
    connect({ host: parent.host, port: parent.port }),
    timeoutMs,
    "the parent proxy did not accept the connection in time",
  );
  const authority = `${host}:${port}`;
  const authLine =
    parent.authorization === undefined ? "" : `Proxy-Authorization: ${parent.authorization}\r\n`;

  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authLine}\r\n`);

  const head = await readHead(socket, timeoutMs).catch((error: unknown) => {
    socket.destroy();

    throw error;
  });
  const status = Number(head.split(" ")[1]);

  if (status !== 200) {
    socket.destroy();

    throw new Error(
      `the parent proxy answered ${Number.isNaN(status) ? "garbage" : status} for ${authority}`,
    );
  }

  return socket;
};
