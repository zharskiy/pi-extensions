import { connect, type Socket } from "node:net";
import type { ParentProxy, SecretRef } from "../config/index.ts";
import { normalizeHost } from "./policy.ts";
import { PARENT_PROXY_SECRET_KEY, type SecretResolver } from "./secrets/index.ts";

export interface ParentRoute {
  host: string;
  port: number;
  noProxy: string[];
  authorization: (repoHash?: string) => Promise<string | undefined>;
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

const parentRouteFromUrl = (
  url: string,
  noProxy: string[],
  authorization: ParentRoute["authorization"],
): ParentRoute => {
  const parsed = new URL(url);

  return {
    host: parsed.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(parsed.port || DEFAULT_PARENT_PORT),
    noProxy,
    authorization,
  };
};

const listOf = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

const parseUrl = (value: string | undefined) => {
  try {
    return value === undefined || value === "" ? undefined : new URL(value);
  } catch {
    return undefined;
  }
};

const ENV_PARENT_SECRET: SecretRef = { env: "HTTPS_PROXY" };

const memoryAuthorization = (resolver: SecretResolver, ref: SecretRef) => async (repoHash?: string) => {
  const result = await resolver.resolve(PARENT_PROXY_SECRET_KEY, ref, repoHash);

  return result.ok ? basicAuthorization(result.value) : undefined;
};

const envRoute = (env: Record<string, string | undefined>, resolver: SecretResolver) => {
  const url = parseUrl(env.HTTPS_PROXY ?? env.https_proxy);

  if (url === undefined || url.protocol !== "http:") {
    return undefined;
  }

  const address = `${url.protocol}//${url.host}`;

  return parentRouteFromUrl(
    address,
    listOf(env.NO_PROXY ?? env.no_proxy),
    memoryAuthorization(resolver, ENV_PARENT_SECRET),
  );
};

export const parentRouteFor = (
  parent: ParentProxy,
  env: Record<string, string | undefined>,
  resolver: SecretResolver,
): ParentRoute | undefined => {
  if (parent === "none") {
    return undefined;
  }

  if (parent === "env") {
    return envRoute(env, resolver);
  }

  const authorization =
    parent.auth === undefined ? async () => undefined : memoryAuthorization(resolver, parent.auth);

  return parentRouteFromUrl(parent.url, parent.noProxy ?? [], authorization);
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

      stop();

      socket.pause();

      const rest = end === -1 ? Buffer.alloc(0) : state.buffer.subarray(end + HEAD_END.length);

      if (rest.length > 0) {
        socket.unshift(rest);
      }

      resolve(state.buffer.subarray(0, end === -1 ? state.buffer.length : end).toString("latin1"));
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

export const dialViaParent = async (parent: ParentRoute, host: string, port: number, repoHash?: string) => {
  const timeoutMs = parent.timeoutMs ?? DIAL_TIMEOUT_MS;
  const authorization = await parent.authorization(repoHash);
  const socket = await connectTo(parent.host, parent.port, timeoutMs);
  const authority = `${host}:${port}`;
  const authLine = authorization === undefined ? "" : `Proxy-Authorization: ${authorization}\r\n`;

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
