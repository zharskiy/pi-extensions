import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { userInfo } from "node:os";
import type { Duplex } from "node:stream";
import { matchesPattern, normalizeHost } from "../config/index.ts";
import { LauncherError } from "../shared/index.ts";
import type { AccessLogEntry } from "./access-log.ts";
import { proxyTokenOf, sameText } from "./auth.ts";
import { createDenialPages } from "./denial-page.ts";
import { createDenials, isHinted, type RecordAccess } from "./denials.ts";
import { type DialAccess, type Dialer, RestrictedAddressError } from "./dial.ts";
import { createInterceptor } from "./intercept.ts";
import { compilePolicy, type EgressPolicy } from "./policy.ts";
import { PROXY_AGENT, rawReply, sendJson } from "./replies.ts";
import { HTTP_PORT, parseAuthority } from "./request-target.ts";
import { createRoutes, hostOf, PLAIN_HTTP } from "./routes.ts";
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
  ca: {
    leaf(host: string): Promise<LeafCertificate>;
    ephemeralLeaf(host: string): Promise<LeafCertificate>;
  };
  log: (entry: AccessLogEntry) => void;
  dial: Dialer;
  upstreamCa?: string | string[];
  helloTimeoutMs?: number;
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

export const startProxyServer = async (options: ProxyServerOptions): Promise<ProxyServer> => {
  const { dial, ca } = options;
  const { repoHash } = options;
  const user = currentUser();
  const sockets = new Set<Socket>();
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;

  const track = (socket: Socket) => {
    sockets.add(socket);

    socket.once("close", () => sockets.delete(socket));
  };

  const record: RecordAccess = (entry) => {
    options.log({ time: new Date().toISOString(), user, repo: repoHash, ...entry });
  };

  const privatePatterns = (options.privateHosts ?? []).map(normalizeHost);
  const decideConnect = compilePolicy(options.policy);
  const pages = createDenialPages({ leaf: (host) => ca.ephemeralLeaf(host) });
  const denials = createDenials(repoHash, record, pages);

  const terminator = createTerminator({
    rules: () => options.runtime.rules(),
    resolver: options.resolver,
    dial: async (host, port, access) => {
      const socket = await dial.dial(host, port, access);

      track(socket);

      return socket;
    },
    upstreamCa: options.upstreamCa,
    note: denials.note,
  });

  const accessOf = (host: string): DialAccess =>
    privatePatterns.some((pattern) => matchesPattern(host, pattern)) ? "private" : "public";

  const intercept = createInterceptor({
    ca,
    helloTimeoutMs,
    accessOf,
    serve: terminator.serve,
    record,
    denials,
  });
  const tunnel = createTunnel({ dial: dial.dial, accessOf, track, record, denials, helloTimeoutMs });
  const routes = createRoutes(denials);

  const isCaller = (request: IncomingMessage) => {
    const token = proxyTokenOf(request.headers["proxy-authorization"]);

    return token !== undefined && sameText(token, options.token);
  };

  const restrictedResolution = async (host: string) => {
    const problem = await dial.checkAddresses(host, accessOf(host)).then(
      () => undefined,
      (error: unknown) => error,
    );

    return problem instanceof RestrictedAddressError ? problem : undefined;
  };

  const handleConnect = async (request: IncomingMessage, client: Socket, head: Buffer) => {
    const target = parseAuthority(request.url);

    if (!isCaller(request)) {
      denials.log(target?.host ?? UNPARSEABLE, AUTH_DENIAL);

      client.end(
        rawReply("407 Proxy Authentication Required", { error: AUTH_DENIAL.reason }, [
          ["Proxy-Authenticate", AUTH_CHALLENGE],
        ]),
      );

      return;
    }

    if (target === undefined) {
      denials.refuse(client, UNPARSEABLE, { rule: "connect", reason: "CONNECT needs host:port" });

      return;
    }

    const host = normalizeHost(target.host);
    const { port } = target;

    if (port === HTTP_PORT) {
      denials.refuse(client, host, PLAIN_HTTP, { port });

      return;
    }

    const decision = decideConnect({ host, port }, await options.runtime.extras());

    if (!decision.allowed && isHinted(decision.rule) && head.length === 0) {
      await denials.show(client, host, decision, { port });

      return;
    }

    if (!decision.allowed) {
      denials.refuse(client, host, decision, { port });

      return;
    }

    const restricted = await restrictedResolution(host);

    if (restricted !== undefined) {
      denials.refuse(client, host, { rule: restricted.rule, reason: restricted.message }, { port });

      return;
    }

    const connection: Connection = { host, port, client, rule: decision.rule };

    if (decision.rule === "credential") {
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
      denials.log(hostOf(request.headers.host), AUTH_DENIAL);

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
