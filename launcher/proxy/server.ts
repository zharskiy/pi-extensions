import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { userInfo } from "node:os";
import type { Duplex } from "node:stream";
import { authorityOf, matchesPattern, normalizeHost, TLS_PORT } from "../config/index.ts";
import { LauncherError } from "../shared/index.ts";
import type { AccessLogEntry } from "./access-log.ts";
import { createDenialPages } from "./denial-page.ts";
import { createDenials, isHinted, type RecordAccess } from "./denials.ts";
import { type DialAccess, type Dialer, ResolutionTimeoutError, RestrictedAddressError } from "./dial.ts";
import type { EgressSettings } from "./files.ts";
import { createInterceptor } from "./intercept.ts";
import { compilePolicy, type EgressDecider } from "./policy.ts";
import { createPreambleGate } from "./preamble.ts";
import { rawReply, statusLine } from "./replies.ts";
import { HTTP_PORT, parseAuthority } from "./request-target.ts";
import { createRoutes, PLAIN_HTTP } from "./routes.ts";
import type { ProxyRuntime } from "./runtime.ts";
import type { SecretResolver } from "./secrets/index.ts";
import { createTerminator, upstreamFailure } from "./terminate.ts";
import type { LeafCertificate } from "./tls-ca.ts";
import { type Connection, createTunnel } from "./tunnel.ts";

export interface ProxyServerOptions {
  listen: { host: string; port: number };
  token: string;
  runtime: ProxyRuntime;
  resolver: SecretResolver;
  ca: {
    leaf(host: string): Promise<LeafCertificate>;
    ephemeralLeaf(host: string): Promise<LeafCertificate>;
  };
  log: (entry: AccessLogEntry) => void;
  dial: Dialer;
  upstreamCa?: string | string[];
  helloTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

export interface ProxyServer {
  port: number;
  close(): Promise<void>;
}

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
  const user = currentUser();
  const sockets = new Set<Socket>();
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;

  const track = (socket: Socket) => {
    sockets.add(socket);

    socket.once("close", () => sockets.delete(socket));
  };

  const record: RecordAccess = (entry) => {
    options.log({ time: new Date().toISOString(), user, ...entry });
  };

  const credentialHosts = [
    ...new Set(options.runtime.rules().map((rule) => authorityOf(rule.host, rule.port ?? TLS_PORT))),
  ];
  const compiled = new WeakMap<EgressSettings, { decide: EgressDecider; privatePatterns: string[] }>();

  const compiledFor = (settings: EgressSettings) => {
    const known = compiled.get(settings);

    if (known !== undefined) {
      return known;
    }

    const fresh = {
      decide: compilePolicy({
        allow: settings.allow,
        deny: settings.deny,
        credentialHosts,
      }),
      privatePatterns: settings.privateHosts.map(normalizeHost),
    };

    compiled.set(settings, fresh);

    return fresh;
  };
  const pages = createDenialPages({ leaf: (host) => ca.ephemeralLeaf(host) });
  const denials = createDenials(record, pages);

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
    handshakeTimeoutMs: options.handshakeTimeoutMs,
  });

  const intercept = createInterceptor({
    ca,
    helloTimeoutMs,
    serve: terminator.serve,
    record,
    denials,
  });
  const tunnel = createTunnel({ dial: dial.dial, track, record, denials, helloTimeoutMs });
  const routes = createRoutes(denials);

  const resolutionProblem = (host: string, access: DialAccess) =>
    dial.checkAddresses(host, access).then(
      () => undefined,
      (error: unknown) => error,
    );

  const handleConnect = async (request: IncomingMessage, client: Socket, head: Buffer) => {
    const target = parseAuthority(request.url);

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

    const { settings, extras } = await options.runtime.egress();
    const { decide, privatePatterns } = compiledFor(settings);
    const decision = decide({ host, port }, extras);

    if (!decision.allowed && isHinted(decision.rule) && head.length === 0) {
      await denials.show(client, host, decision, { port });

      return;
    }

    if (!decision.allowed) {
      denials.refuse(client, host, decision, { port });

      return;
    }

    const access: DialAccess = privatePatterns.some((pattern) => matchesPattern(host, pattern))
      ? "private"
      : "public";
    const problem = await resolutionProblem(host, access);

    if (problem instanceof RestrictedAddressError) {
      denials.refuse(client, host, { rule: problem.rule, reason: problem.message }, { port });

      return;
    }

    if (problem instanceof ResolutionTimeoutError) {
      denials.note(host, { rule: "upstream", reason: problem.message }, { port });

      client.end(rawReply(statusLine(502), { error: upstreamFailure(problem) }));

      return;
    }

    const connection: Connection = { host, port, access, client, rule: decision.rule };

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

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    try {
      routes(request, response);
    } catch {
      response.destroy();
    }
  });

  server.on("connect", onConnect);

  const gate = createPreambleGate(options.token, (socket) => server.emit("connection", socket));

  gate.on("connection", track);

  await new Promise<void>((resolve, reject) => {
    gate.once("error", (error) =>
      reject(
        new LauncherError(
          `proxy cannot listen on ${options.listen.host}:${options.listen.port}: ${error.message}`,
          "stop the process using the port or pick another one",
        ),
      ),
    );

    gate.listen(options.listen.port, options.listen.host, () => resolve());
  });

  const port = (gate.address() as AddressInfo).port;

  const close = async () => {
    await options.resolver.close();

    terminator.close();

    await new Promise<void>((resolve) => {
      sockets.forEach((socket) => {
        socket.destroy();
      });

      server.closeAllConnections();

      server.close();

      gate.close(() => resolve());
    });
  };

  return { port, close };
};
