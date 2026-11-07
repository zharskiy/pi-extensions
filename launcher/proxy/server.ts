import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { userInfo } from "node:os";
import type { Duplex } from "node:stream";
import { createSecureContext, type SecureContext, TLSSocket } from "node:tls";
import { LauncherError, sha256Hex } from "../shared/index.ts";
import type { AccessLogEntry } from "./access-log.ts";
import { parseProxyAuthorization, sameText } from "./auth.ts";
import type { ControlMessage, ControlReply } from "./control.ts";
import { createDialer, type DialAccess, type Dialer, RestrictedAddressError } from "./dial.ts";
import type { DenialRecord } from "./dynamic.ts";
import {
  type Denial,
  decideConnect,
  type EgressPolicy,
  isGatewayHost,
  matchesPattern,
  normalizeHost,
} from "./policy.ts";
import { isRuleHost } from "./rules.ts";
import type { ProxyRuntime } from "./runtime.ts";
import type { SecretResolver } from "./secrets/index.ts";
import { clientHelloRecordLength, parseServerName } from "./sni.ts";
import { createTerminator } from "./terminate.ts";
import type { LeafCertificate } from "./tls-ca.ts";

export interface ProxyServerOptions {
  listen: { host: string; port: number };
  policy: EgressPolicy;
  policyHash?: string;
  controlToken: string;
  runtime: ProxyRuntime;
  resolver: SecretResolver;
  gateway?: { host: string; port: number; url: string };
  privateHosts?: string[];
  ca?: { leaf(host: string): Promise<LeafCertificate> };
  log: (entry: AccessLogEntry) => void;
  dial?: Dialer;
  upstreamCa?: string | string[];
  helloTimeoutMs?: number;
  onControl?: (message: ControlMessage) => ControlReply;
}

export interface ProxyServer {
  port: number;
  policyHash: string;
  close(): Promise<void>;
}

interface Connection {
  host: string;
  port: number;
  repoHash: string;
  extras: string[];
  sni?: string;
  client: Socket;
}

type Caller = { kind: "repo"; repoHash: string } | { kind: "control" };

type DenialInput = Pick<Denial, "rule" | "reason">;

const PROXY_AGENT = "pi-sandbox";

const AUTH_CHALLENGE = `Basic realm="${PROXY_AGENT}"`;

const AUTH_DENIAL = { rule: "auth", reason: "missing or wrong Proxy-Authorization" };

const HINTED_RULES = new Set(["egress.allow", "egress.port"]);

const HANDSHAKE_RECORD = 0x16;

const MAX_HELLO_BYTES = 16_389;

const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

const MAX_DENIALS = 200;

const MAX_CONTROL_BYTES = 1024 * 1024;

const ESTABLISHED = `HTTP/1.1 200 Connection Established\r\nProxy-Agent: ${PROXY_AGENT}\r\n\r\n`;

const currentUser = () => {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
};

const rawResponse = (status: string, body: object, extra: string[] = []) => {
  const text = JSON.stringify(body);

  return [
    `HTTP/1.1 ${status}`,
    `Proxy-Agent: ${PROXY_AGENT}`,
    ...extra,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(text)}`,
    "Connection: close",
    "",
    text,
  ].join("\r\n");
};

const denialBody = (host: string, denial: DenialInput) => ({
  denied: host,
  rule: denial.rule,
  reason: denial.reason,
});

const forbiddenStatus = (denial: DenialInput) =>
  HINTED_RULES.has(denial.rule) ? `403 ${denial.reason}` : "403 Forbidden";

const parseAuthority = (authority: string | undefined) => {
  try {
    const url = new URL(`http://${authority ?? ""}`);
    const valid = url.username === "" && url.pathname === "/" && url.search === "" && url.port !== "";

    return valid ? { host: url.hostname, port: Number(url.port) } : undefined;
  } catch {
    return undefined;
  }
};

const UNPARSEABLE = "unparseable";

const hostOf = (authority: string | undefined) => {
  try {
    const url = new URL(`http://${authority ?? ""}`);
    const valid = url.username === "" && url.password === "" && url.pathname === "/" && url.search === "";

    return valid && url.hostname !== "" ? url.hostname : UNPARSEABLE;
  } catch {
    return UNPARSEABLE;
  }
};

const isHelloComplete = (buffer: Buffer) => {
  if (buffer.length === 0) {
    return false;
  }

  const length = clientHelloRecordLength(buffer);

  return (
    buffer[0] !== HANDSHAKE_RECORD ||
    buffer.length >= MAX_HELLO_BYTES ||
    (length !== undefined && buffer.length >= length)
  );
};

const readClientHello = (socket: Socket, head: Buffer, timeoutMs: number) =>
  new Promise<Buffer>((resolve) => {
    const state = { buffer: head };

    const finish = () => {
      clearTimeout(timer);

      socket.off("data", collect);

      socket.off("end", finish);

      socket.off("close", finish);

      socket.pause();

      resolve(state.buffer);
    };

    const collect = (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);

      if (isHelloComplete(state.buffer)) {
        finish();
      }
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on("data", collect);

    socket.once("end", finish);

    socket.once("close", finish);

    if (isHelloComplete(state.buffer)) {
      finish();
    }

    socket.resume();
  });

const readBody = (request: IncomingMessage) =>
  new Promise<string | undefined>((resolve) => {
    const chunks: Buffer[] = [];
    const state = { size: 0 };

    request.on("data", (chunk: Buffer) => {
      state.size += chunk.length;

      if (state.size > MAX_CONTROL_BYTES) {
        request.destroy();

        resolve(undefined);

        return;
      }

      chunks.push(chunk);
    });

    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));

    request.once("error", () => resolve(undefined));
  });

const isStringMap = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

const parseControlMessage = (text: string | undefined): ControlMessage | undefined => {
  try {
    const message = JSON.parse(text ?? "") as { type?: unknown; secrets?: unknown };

    return message.type === "env-secrets" && isStringMap(message.secrets)
      ? { type: "env-secrets", secrets: message.secrets }
      : undefined;
  } catch {
    return undefined;
  }
};

const sinceOf = (url: string) => {
  const since = Number(new URL(url, "http://proxy").searchParams.get("since") ?? "0");

  return Number.isFinite(since) ? since : 0;
};

const pathOf = (url: string | undefined) => (url?.startsWith("/") ? (url.split("?")[0] ?? "") : "");

export const startProxyServer = async (options: ProxyServerOptions): Promise<ProxyServer> => {
  const dial = options.dial ?? createDialer();
  const policyHash = options.policyHash ?? sha256Hex(JSON.stringify(options.policy));
  const user = currentUser();
  const sockets = new Set<Socket>();
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const denials = new Map<string, DenialRecord[]>();
  const contexts = new Map<string, Promise<SecureContext>>();
  const gatewayPath = options.gateway === undefined ? undefined : new URL(options.gateway.url).pathname;

  const track = (socket: Socket) => {
    sockets.add(socket);

    socket.once("close", () => sockets.delete(socket));
  };

  const record = (entry: Omit<AccessLogEntry, "time" | "user">) => {
    options.log({ time: new Date().toISOString(), user, ...entry });
  };

  const terminator = createTerminator({
    rules: () => options.runtime.rules(),
    resolver: options.resolver,
    dial: async (host, port, access) => {
      const socket = await dial(host, port, access);

      track(socket);

      return socket;
    },
    upstreamCa: options.upstreamCa,
    log: record,
  });

  const rememberDenial = (repoHash: string, entry: DenialRecord) => {
    denials.set(repoHash, [...(denials.get(repoHash) ?? []), entry].slice(-MAX_DENIALS));
  };

  const recordDenial = (
    host: string,
    denial: DenialInput,
    context: { port?: number; repoHash?: string; sni?: string } = {},
  ) => {
    record({
      repo: context.repoHash,
      host,
      sni: context.sni,
      decision: "deny",
      rule: denial.rule,
      reason: denial.reason,
      bytesIn: 0,
      bytesOut: 0,
    });

    if (context.repoHash !== undefined) {
      rememberDenial(context.repoHash, {
        time: Date.now(),
        host,
        port: context.port ?? 0,
        repoHash: context.repoHash,
        rule: denial.rule,
        reason: denial.reason,
      });
    }
  };

  const refuse = (
    socket: Socket,
    host: string,
    denial: DenialInput,
    context: { port?: number; repoHash?: string } = {},
  ) => {
    recordDenial(host, denial, context);

    socket.end(rawResponse(forbiddenStatus(denial), denialBody(host, denial)));
  };

  const accessOf = (host: string): DialAccess => {
    const isGateway = options.gateway !== undefined && normalizeHost(options.gateway.host) === host;
    const isPrivate = (options.privateHosts ?? []).some((pattern) =>
      matchesPattern(host, normalizeHost(pattern)),
    );

    return isGateway || isPrivate ? "private" : "public";
  };

  const secureContextFor = (host: string) => {
    const known = contexts.get(host);

    if (known !== undefined) {
      return known;
    }

    if (options.ca === undefined) {
      return Promise.reject(new LauncherError("the proxy needs the launcher CA to terminate TLS"));
    }

    const created = options.ca.leaf(host).then((leaf) => createSecureContext(leaf));

    contexts.set(host, created);

    created.catch(() => contexts.delete(host));

    return created;
  };

  const isGatewayTarget = (host: string, port: number) => isGatewayHost(host, port, options.policy);

  const handshakeDenial = (connection: Connection) => {
    if (connection.sni === undefined) {
      return { rule: "sni", reason: "no TLS server name" };
    }

    const decision = decideConnect(
      { host: connection.host, port: connection.port, sni: connection.sni },
      { allow: [`${connection.host}:${connection.port}`], mcpHosts: [] },
    );

    return decision.allowed ? { rule: "tls", reason: "TLS handshake with the client failed" } : decision;
  };

  const startTls = (connection: Connection, secureContext: SecureContext) => {
    const { client, host, port } = connection;
    const gateway = isGatewayTarget(host, port);

    client.write(ESTABLISHED);

    const secure = new TLSSocket(client, {
      isServer: true,
      secureContext,
      ALPNProtocols: ["http/1.1"],
      SNICallback: (servername, callback) => {
        connection.sni = servername;

        if (normalizeHost(servername) !== host) {
          callback(new Error(`TLS server name ${servername} does not match ${host}`));

          return;
        }

        callback(null, secureContext);
      },
    });
    const state = { secured: false };

    secure.on("error", () => client.destroy());

    secure.once("secure", () => {
      connection.sni = secure.servername || undefined;

      if (connection.sni === undefined) {
        secure.destroy();

        return;
      }

      state.secured = true;

      terminator.serve(secure, {
        host,
        port,
        repoHash: connection.repoHash,
        access: accessOf(host),
        ...(gateway && gatewayPath !== undefined ? { pathPrefix: gatewayPath } : {}),
      });
    });

    client.once("close", () => {
      if (state.secured) {
        record({
          repo: connection.repoHash,
          host,
          sni: connection.sni,
          decision: "allow",
          rule: gateway ? "gateway" : "terminate",
          bytesIn: client.bytesWritten,
          bytesOut: client.bytesRead,
        });

        return;
      }

      recordDenial(host, handshakeDenial(connection), {
        port,
        repoHash: connection.repoHash,
        sni: connection.sni,
      });
    });
  };

  const intercept = async (connection: Connection, head: Buffer) => {
    const { client, host, port, repoHash } = connection;

    if (head.length > 0) {
      refuse(
        client,
        host,
        { rule: "sni", reason: "client sent data before the tunnel was established" },
        { port, repoHash },
      );

      return;
    }

    const secureContext = await secureContextFor(host).catch(() => undefined);

    if (secureContext === undefined) {
      refuse(
        client,
        host,
        { rule: "tls", reason: `no certificate can be issued for ${host}` },
        { port, repoHash },
      );

      return;
    }

    startTls(connection, secureContext);
  };

  const splice = (connection: Connection, upstream: Socket, hello: Buffer) => {
    const counters = { bytesIn: 0, bytesOut: hello.length };
    const { client } = connection;

    client.on("data", (chunk: Buffer) => {
      counters.bytesOut += chunk.length;
    });

    upstream.on("data", (chunk: Buffer) => {
      counters.bytesIn += chunk.length;
    });

    client.once("close", () => {
      record({
        repo: connection.repoHash,
        host: connection.host,
        sni: connection.sni,
        decision: "allow",
        rule: "egress.allow",
        ...counters,
      });
    });

    upstream.write(hello);

    client.pipe(upstream).pipe(client);

    client.on("close", () => upstream.destroy());

    upstream.on("close", () => client.destroy());

    client.resume();
  };

  const checkHello = async (connection: Connection, upstream: Socket, head: Buffer) => {
    const hello = await readClientHello(connection.client, head, helloTimeoutMs);
    const sni = parseServerName(hello);

    connection.sni = sni;

    const decision =
      sni === undefined
        ? ({ allowed: false, rule: "sni", reason: "no TLS ClientHello with a server name" } as const)
        : decideConnect(
            { host: connection.host, port: connection.port, sni },
            options.policy,
            connection.extras,
          );

    if (!decision.allowed) {
      recordDenial(connection.host, decision, { port: connection.port, repoHash: connection.repoHash, sni });

      upstream.destroy();

      connection.client.destroy();

      return;
    }

    splice(connection, upstream, hello);
  };

  const tunnel = async (connection: Connection, head: Buffer) => {
    const { client, host, port, repoHash } = connection;
    const upstream = await dial(host, port, accessOf(host)).catch((error: Error) => error);

    if (upstream instanceof RestrictedAddressError) {
      refuse(client, host, { rule: upstream.rule, reason: upstream.message }, { port, repoHash });

      return;
    }

    if (upstream instanceof Error) {
      recordDenial(host, { rule: "upstream", reason: upstream.message }, { port, repoHash });

      client.end(rawResponse("502 Bad Gateway", { error: `cannot reach ${host}: ${upstream.message}` }));

      return;
    }

    track(upstream);

    if (client.destroyed) {
      upstream.destroy();

      return;
    }

    upstream.on("error", () => client.destroy());

    client.once("close", () => upstream.destroy());

    client.write(ESTABLISHED);

    await checkHello(connection, upstream, head);
  };

  const callerOf = async (request: IncomingMessage): Promise<Caller | undefined> => {
    const parsed = parseProxyAuthorization(request.headers["proxy-authorization"]);

    if (parsed?.kind === "control") {
      return sameText(parsed.token, options.controlToken) ? { kind: "control" } : undefined;
    }

    const repoHash = parsed === undefined ? undefined : await options.runtime.repoOf(parsed.token);

    return repoHash === undefined ? undefined : { kind: "repo", repoHash };
  };

  const decide = async (host: string, port: number, repoHash: string) => {
    const decision = decideConnect({ host, port }, options.policy);

    if (decision.allowed || !HINTED_RULES.has(decision.rule)) {
      return { decision, extras: [] };
    }

    const extras = await options.runtime.extras(repoHash);

    return { decision: decideConnect({ host, port }, options.policy, extras), extras };
  };

  const handleConnect = async (request: IncomingMessage, client: Socket, head: Buffer) => {
    const target = parseAuthority(request.url);
    const caller = await callerOf(request);

    if (caller?.kind !== "repo") {
      recordDenial(target?.host ?? UNPARSEABLE, AUTH_DENIAL);

      client.end(
        rawResponse("407 Proxy Authentication Required", { error: AUTH_DENIAL.reason }, [
          `Proxy-Authenticate: ${AUTH_CHALLENGE}`,
        ]),
      );

      return;
    }

    if (target === undefined) {
      refuse(
        client,
        UNPARSEABLE,
        { rule: "connect", reason: "CONNECT needs host:port" },
        { repoHash: caller.repoHash },
      );

      return;
    }

    const host = normalizeHost(target.host);
    const { decision, extras } = await decide(host, target.port, caller.repoHash);

    if (!decision.allowed) {
      refuse(client, host, decision, { port: target.port, repoHash: caller.repoHash });

      return;
    }

    const connection: Connection = { host, port: target.port, repoHash: caller.repoHash, extras, client };
    const terminated =
      isGatewayTarget(host, target.port) || isRuleHost(await options.runtime.rules(), host, target.port);

    if (terminated) {
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

  const sendJson = (
    response: ServerResponse,
    status: number,
    body: object,
    extra: Record<string, string> = {},
  ) => {
    response.writeHead(status, { "content-type": "application/json", "proxy-agent": PROXY_AGENT, ...extra });

    response.end(JSON.stringify(body));
  };

  const challenge = (response: ServerResponse) =>
    sendJson(response, 407, { error: AUTH_DENIAL.reason }, { "proxy-authenticate": AUTH_CHALLENGE });

  const handleControl = async (request: IncomingMessage, response: ServerResponse) => {
    const message = parseControlMessage(await readBody(request));

    if (message === undefined) {
      sendJson(response, 400, { ok: false, error: "unknown control message" });

      return;
    }

    const reply = options.onControl?.(message) ?? { ok: false, error: "control messages are not accepted" };

    sendJson(response, reply.ok ? 200 : 400, reply);
  };

  const handlePlain = async (request: IncomingMessage, response: ServerResponse) => {
    const caller = await callerOf(request);
    const path = pathOf(request.url);

    if (caller === undefined || (path === "/control" && caller.kind !== "control")) {
      recordDenial(hostOf(request.headers.host), AUTH_DENIAL);

      challenge(response);

      return;
    }

    if (request.method === "GET" && path === "/healthz") {
      sendJson(response, 200, { ok: true, policyHash, pid: process.pid });

      return;
    }

    if (request.method === "GET" && path === "/policy") {
      sendJson(response, 200, { ...options.policy, policyHash });

      return;
    }

    if (request.method === "GET" && path === "/denials" && caller.kind === "repo") {
      const since = sinceOf(request.url ?? "/");
      const found = (denials.get(caller.repoHash) ?? []).filter((entry) => entry.time >= since);

      sendJson(response, 200, { denials: found });

      return;
    }

    if (request.method === "POST" && path === "/control") {
      await handleControl(request, response);

      return;
    }

    const host = hostOf(request.headers.host);
    const denial = { rule: "plain-http", reason: "only HTTPS through CONNECT is proxied" };

    recordDenial(host, denial, caller.kind === "repo" ? { repoHash: caller.repoHash, port: 80 } : {});

    sendJson(response, 403, denialBody(host, denial));
  };

  const server = createServer((request, response) => {
    void handlePlain(request, response).catch(() => response.destroy());
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

  const close = () =>
    new Promise<void>((resolve) => {
      sockets.forEach((socket) => {
        socket.destroy();
      });

      server.closeAllConnections();

      server.close(() => resolve());
    });

  return { port: (server.address() as AddressInfo).port, policyHash, close };
};
