import { connect, type Socket } from "node:net";
import { normalizeHost, type ParentProxy } from "../config/index.ts";

export interface ParentRoute {
  host: string;
  port: number;
  noProxy: string[];
  authorization?: string;
  timeoutMs?: number;
}

const HEAD_END = "\r\n\r\n";

const MAX_HEAD_BYTES = 16_384;

const DEFAULT_PARENT_PORT = 80;

const DIAL_TIMEOUT_MS = 10_000;

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

const listOf = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

const setOf = (value: string | undefined) => (value === undefined || value === "" ? undefined : value);

const parseUrl = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

export type ParentTarget = { host: string; port: number } | { unsupported: string } | undefined;

export const parentTarget = (parent: ParentProxy, env: Record<string, string | undefined>): ParentTarget => {
  const text = parent === "none" ? undefined : (setOf(env.HTTPS_PROXY) ?? setOf(env.https_proxy));

  if (text === undefined) {
    return undefined;
  }

  const url = parseUrl(text);

  if (url === undefined) {
    return { unsupported: "HTTPS_PROXY is not a URL" };
  }

  if (url.protocol !== "http:") {
    return {
      unsupported: `HTTPS_PROXY uses ${url.protocol.slice(0, -1)}, only http parent proxies are supported`,
    };
  }

  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(url.port || DEFAULT_PARENT_PORT),
  };
};

export const parentRouteFor = (
  parent: ParentProxy,
  env: Record<string, string | undefined>,
  credentials?: string,
): ParentRoute | undefined => {
  const target = parentTarget(parent, env);

  if (target === undefined || "unsupported" in target) {
    return undefined;
  }

  return {
    ...target,
    noProxy: listOf(setOf(env.NO_PROXY) ?? env.no_proxy),
    authorization: credentials === undefined ? undefined : basicAuthorization(credentials),
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

const connectTo = (host: string, port: number, timeoutMs: number) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host, port });

    const timer = setTimeout(() => {
      socket.destroy();

      reject(new Error("the parent proxy did not accept the connection in time"));
    }, timeoutMs);

    const onError = (error: Error) => {
      clearTimeout(timer);

      reject(error);
    };

    socket.once("connect", () => {
      clearTimeout(timer);

      socket.off("error", onError);

      resolve(socket);
    });

    socket.once("error", onError);
  });

export const dialViaParent = async (parent: ParentRoute, host: string, port: number) => {
  const timeoutMs = parent.timeoutMs ?? DIAL_TIMEOUT_MS;
  const socket = await connectTo(parent.host, parent.port, timeoutMs);
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
