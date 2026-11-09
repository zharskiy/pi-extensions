import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { userInfo } from "node:os";
import type { Duplex } from "node:stream";
import { matchesPattern, normalizeHost } from "../config/index.ts";
import { LauncherError } from "../shared/index.ts";
import type { AccessLogEntry } from "./access-log.ts";
import { proxyTokenOf, sameText } from "./auth.ts";
import { createDenialPages } from "./denial-page.ts";
import { createDenials, isHinted } from "./denials.ts";
import { createDialer, type DialAccess, type Dialer } from "./dial.ts";
import { createInterceptor } from "./intercept.ts";
import { decideConnect, type EgressPolicy } from "./policy.ts";
import { PROXY_AGENT, rawReply, sendJson } from "./replies.ts";
import { createRoutes, hostOf } from "./routes.ts";
import { isRuleHost } from "./rules.ts";
import type { ProxyRuntime } from "./runtime.ts";
import type { SecretResolver } from "./secrets/index.ts";
import { createTerminator } from "./terminate.ts";
import type { LeafCertificate } from "./tls-ca.ts";
import { type Connection, createTunnel } from "./tunnel.ts";

export interface ProxyServerOptions {
  listen: { host: string; port: number };
  policy: EgressPolicy;
  repoHash: string;
  token: string;
  runtime: ProxyRuntime;
  resolver: SecretResolver;
  privateHosts?: string[];
  ca?: {
    leaf(host: string): Promise<LeafCertificate>;
    ephemeralLeaf(host: string): Promise<LeafCertificate>;
  };
  log: (entry: AccessLogEntry) => void;
  dial?: Dialer;
  upstreamCa?: string | string[];
  helloTimeoutMs?: number;
  denialPages?: { maxNames?: number; mintsPerMinute?: number };
}

export interface ProxyServer {
  port: number;
  close(): Promise<void>;
}

const AUTH_CHALLENGE = `Basic realm="${PROXY_AGENT}"`;

const AUTH_DENIAL = { rule: "auth", reason: "missing or wrong Proxy-Authorization" };

const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

const UNPARSEABLE = "unparseable";

const currentUser = () => {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
};

const parseAuthority = (authority: string | undefined) => {
  try {
    const url = new URL(`http://${authority ?? ""}`);
    const valid = url.username === "" && url.pathname === "/" && url.search === "" && url.port !== "";

    return valid ? { host: url.hostname, port: Number(url.port) } : undefined;
  } catch {
    return undefined;
  }
};

export const startProxyServer = async (options: ProxyServerOptions): Promise<ProxyServer> => {
  const dial = options.dial ?? createDialer();
  const { repoHash } = options;
  const user = currentUser();
  const sockets = new Set<Socket>();
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;

  const track = (socket: Socket) => {
    sockets.add(socket);

    socket.once("close", () => sockets.delete(socket));
  };

  const record = (entry: Omit<AccessLogEntry, "time" | "user">) => {
    options.log({ time: new Date().toISOString(), user, ...entry });
  };

  const terminator = createTerminator({
    rules: async () => options.runtime.rules(),
    resolver: options.resolver,
    dial: async (host, port, access, repo) => {
      const socket = await dial(host, port, access, repo);

      track(socket);

      return socket;
    },
    upstreamCa: options.upstreamCa,
    log: record,
  });
  const ca = options.ca;
  const pages =
    ca === undefined
      ? undefined
      : createDenialPages({ leaf: (host) => ca.ephemeralLeaf(host), ...options.denialPages });
  const denials = createDenials(record, pages);

  const accessOf = (host: string): DialAccess =>
    (options.privateHosts ?? []).some((pattern) => matchesPattern(host, normalizeHost(pattern)))
      ? "private"
      : "public";

  const intercept = createInterceptor({
    ca,
    helloTimeoutMs,
    accessOf,
    serve: terminator.serve,
    record,
    denials,
  });
  const tunnel = createTunnel({ dial, accessOf, track, record, denials, helloTimeoutMs });
  const routes = createRoutes(repoHash, denials);

  const isCaller = (request: IncomingMessage) => {
    const token = proxyTokenOf(request.headers["proxy-authorization"]);

    return token !== undefined && sameText(token, options.token);
  };

  const decide = async (host: string, port: number) => {
    const decision = decideConnect({ host, port }, options.policy);

    if (decision.allowed || !isHinted(decision.rule)) {
      return decision;
    }

    return decideConnect({ host, port }, options.policy, await options.runtime.extras());
  };

  const isTerminated = (host: string, port: number) => isRuleHost(options.runtime.rules(), host, port);

  const handleConnect = async (request: IncomingMessage, client: Socket, head: Buffer) => {
    const target = parseAuthority(request.url);

    if (!isCaller(request)) {
      denials.note(target?.host ?? UNPARSEABLE, AUTH_DENIAL);

      client.end(
        rawReply("407 Proxy Authentication Required", { error: AUTH_DENIAL.reason }, [
          `Proxy-Authenticate: ${AUTH_CHALLENGE}`,
        ]),
      );

      return;
    }

    if (target === undefined) {
      denials.refuse(
        client,
        UNPARSEABLE,
        { rule: "connect", reason: "CONNECT needs host:port" },
        { repoHash },
      );

      return;
    }

    const host = normalizeHost(target.host);
    const { port } = target;
    const decision = await decide(host, port);

    if (!decision.allowed && isHinted(decision.rule) && head.length === 0) {
      await denials.show(client, host, decision, { port, repoHash });

      return;
    }

    if (!decision.allowed) {
      denials.refuse(client, host, decision, { port, repoHash });

      return;
    }

    const connection: Connection = { host, port, repoHash, client };

    if (isTerminated(host, port)) {
      await intercept(connection, head);

      return;
    }

    await tunnel(connection, head);
  };

  const onConnect = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const client = socket as Socket;

    track(client);

    client.on("error", () => client.destroy());

    void handleConnect(request, client, head).catch(() => client.destroy());
  };

  const handlePlain = (request: IncomingMessage, response: ServerResponse) => {
    if (!isCaller(request)) {
      denials.note(hostOf(request.headers.host), AUTH_DENIAL);

      sendJson(response, 407, { error: AUTH_DENIAL.reason }, { "proxy-authenticate": AUTH_CHALLENGE });

      return;
    }

    routes(request, response);
  };

  const server = createServer((request, response) => {
    try {
      handlePlain(request, response);
    } catch {
      response.destroy();
    }
  });

  server.on("connect", onConnect);

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) =>
      reject(
        new LauncherError(
          `proxy cannot listen on ${options.listen.host}:${options.listen.port}: ${error.message}`,
          "stop the process using the port or pick another one",
        ),
      ),
    );

    server.listen(options.listen.port, options.listen.host, () => resolve());
  });

  const port = (server.address() as AddressInfo).port;

  const close = async () => {
    await options.resolver.close();

    terminator.close();

    await new Promise<void>((resolve) => {
      sockets.forEach((socket) => {
        socket.destroy();
      });

      server.closeAllConnections();

      server.close(() => resolve());
    });
  };

  return { port, close };
};
