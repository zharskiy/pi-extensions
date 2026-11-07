import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  type AddressInfo,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { userInfo } from "node:os";
import type { Duplex } from "node:stream";
import { createSecureContext, type SecureContext, TLSSocket } from "node:tls";
import { LauncherError, OAUTH_ROUTES, sha256Hex } from "../shared/index.ts";
import type { AccessLogEntry } from "./access-log.ts";
import { parseProxyAuthorization, sameText } from "./auth.ts";
import type { ControlMessage, ControlReply } from "./control.ts";
import { createDenialPages } from "./denial-page.ts";
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
import type { VaultHook, VaultReply } from "./vault/index.ts";

export interface ProxyServerOptions {
  listen: { host: string; port: number; extraHosts?: string[] };
  policy: EgressPolicy;
  policyHash?: string;
  controlToken: string;
  runtime: ProxyRuntime;
  resolver: SecretResolver;
  gateway?: { host: string; port: number; url: string };
  privateHosts?: string[];
  ca?: {
    leaf(host: string): Promise<LeafCertificate>;
    ephemeralLeaf(host: string): Promise<LeafCertificate>;
  };
  log: (entry: AccessLogEntry) => void;
  dial?: Dialer;
  upstreamCa?: string | string[];
  helloTimeoutMs?: number;
  leafRecheckMs?: number;
  onControl?: (message: ControlMessage) => ControlReply | Promise<ControlReply>;
  onListenError?: (line: string) => void;
  vault?: VaultHook;
  denialPages?: { maxNames?: number; mintsPerMinute?: number };
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

interface CachedContext {
  cert: string;
  context: SecureContext;
  checkedAt: number;
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

const DEFAULT_LEAF_RECHECK_MS = 60_000;

const MAX_DENIALS = 200;

const MAX_CONTROL_BYTES = 1024 * 1024;

const TOKEN_HASH = /^[0-9a-f]{64}$/;

const OAUTH_PATHS = new Set<string>(Object.values(OAUTH_ROUTES));

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

interface Body {
  text?: string;
  overflow: boolean;
}

const readBody = (request: IncomingMessage) =>
  new Promise<Body>((resolve) => {
    const chunks: Buffer[] = [];
    const state = { size: 0 };

    const onData = (chunk: Buffer) => {
      state.size += chunk.length;

      if (state.size > MAX_CONTROL_BYTES) {
        request.off("data", onData);

        request.pause();

        resolve({ overflow: true });

        return;
      }

      chunks.push(chunk);
    };

    request.on("data", onData);

    request.once("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), overflow: false }));

    request.once("error", () => resolve({ overflow: false }));
  });

const isStringMap = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

const tokenHashOf = (value: unknown) =>
  typeof value === "string" && TOKEN_HASH.test(value) ? { repoTokenHash: value } : {};

const parseControlMessage = (text: string | undefined): ControlMessage | undefined => {
  try {
    const message = JSON.parse(text ?? "") as { type?: unknown; secrets?: unknown; repoTokenHash?: unknown };

    return message.type === "env-secrets" && isStringMap(message.secrets)
      ? { type: "env-secrets", secrets: message.secrets, ...tokenHashOf(message.repoTokenHash) }
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

const flowOf = (url: string | undefined) =>
  new URL(url ?? "/", "http://proxy").searchParams.get("flow") ?? "";

const parseJsonBody = (text: string | undefined): unknown => {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
};

export const startProxyServer = async (options: ProxyServerOptions): Promise<ProxyServer> => {
  const dial = options.dial ?? createDialer();
  const policyHash = options.policyHash ?? sha256Hex(JSON.stringify(options.policy));
  const user = currentUser();
  const sockets = new Set<Socket>();
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const denials = new Map<string, DenialRecord[]>();
  const leafRecheckMs = options.leafRecheckMs ?? DEFAULT_LEAF_RECHECK_MS;
  const contexts = new Map<string, Promise<CachedContext>>();
  const gatewayPath = options.gateway === undefined ? undefined : new URL(options.gateway.url).pathname;

  const track = (socket: Socket) => {
    sockets.add(socket);

    socket.once("close", () => sockets.delete(socket));
  };

  const record = (entry: Omit<AccessLogEntry, "time" | "user">) => {
    options.log({ time: new Date().toISOString(), user, ...entry });
  };

  const terminator = createTerminator({
    rules: (repoHash) => options.runtime.rules(repoHash),
    resolver: options.resolver,
    dial: async (host, port, access, repoHash) => {
      const socket = await dial(host, port, access, repoHash);

      track(socket);

      return socket;
    },
    upstreamCa: options.upstreamCa,
    log: record,
    vault: options.vault,
  });
  const ca = options.ca;
  const pages =
    ca === undefined
      ? undefined
      : createDenialPages({ leaf: (host) => ca.ephemeralLeaf(host), ...options.denialPages });

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

  const showDenial = async (
    client: Socket,
    host: string,
    denial: DenialInput,
    context: { port: number; repoHash: string },
  ) => {
    recordDenial(host, denial, context);

    const secureContext = await pages?.context(host);

    if (secureContext === undefined || pages === undefined) {
      client.end(rawResponse(forbiddenStatus(denial), denialBody(host, denial)));

      return;
    }

    if (client.destroyed) {
      return;
    }

    client.write(ESTABLISHED);

    pages.serve(client, secureContext, denial.reason);
  };

  const accessOf = (host: string): DialAccess => {
    const isGateway = options.gateway !== undefined && normalizeHost(options.gateway.host) === host;
    const isPrivate = (options.privateHosts ?? []).some((pattern) =>
      matchesPattern(host, normalizeHost(pattern)),
    );

    return isGateway || isPrivate ? "private" : "public";
  };

  const loadContext = async (
    ca: NonNullable<ProxyServerOptions["ca"]>,
    host: string,
    known: CachedContext | undefined,
  ): Promise<CachedContext> => {
    const leaf = await ca.leaf(host);
    const context = known?.cert === leaf.cert ? known.context : createSecureContext(leaf);

    return { cert: leaf.cert, context, checkedAt: Date.now() };
  };

  const secureContextFor = async (host: string) => {
    if (options.ca === undefined) {
      throw new LauncherError("the proxy needs the launcher CA to terminate TLS");
    }

    const known = await contexts.get(host)?.catch(() => undefined);

    if (known !== undefined && Date.now() - known.checkedAt < leafRecheckMs) {
      return known.context;
    }

    const loading = loadContext(options.ca, host, known);

    contexts.set(host, loading);

    loading.catch(() => contexts.delete(host));

    return (await loading).context;
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
    const handshake = setTimeout(() => client.destroy(), helloTimeoutMs);

    secure.on("error", () => client.destroy());

    secure.once("secure", () => {
      clearTimeout(handshake);

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
      clearTimeout(handshake);

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

  const helloDecision = (connection: Connection, sni: string | undefined) =>
    sni === undefined
      ? ({ allowed: false, rule: "sni", reason: "no TLS ClientHello with a server name" } as const)
      : decideConnect(
          { host: connection.host, port: connection.port, sni },
          options.policy,
          connection.extras,
        );

  const dialUpstream = async (connection: Connection) => {
    const { host, port, repoHash } = connection;
    const upstream = await dial(host, port, accessOf(host), repoHash).catch((error: Error) => error);

    if (!(upstream instanceof Error)) {
      return upstream;
    }

    const rule = upstream instanceof RestrictedAddressError ? upstream.rule : "upstream";

    recordDenial(host, { rule, reason: upstream.message }, { port, repoHash });

    return undefined;
  };

  const restrictedResolution = async (host: string) => {
    const problem = await dial.checkAddresses?.(host, accessOf(host)).then(
      () => undefined,
      (error: unknown) => error,
    );

    return problem instanceof RestrictedAddressError ? problem : undefined;
  };

  const tunnel = async (connection: Connection, head: Buffer) => {
    const { client, host, port, repoHash } = connection;
    const restricted = await restrictedResolution(host);

    if (restricted !== undefined) {
      refuse(client, host, { rule: restricted.rule, reason: restricted.message }, { port, repoHash });

      return;
    }

    client.write(ESTABLISHED);

    const hello = await readClientHello(client, head, helloTimeoutMs);
    const sni = parseServerName(hello);
    const decision = helloDecision(connection, sni);

    connection.sni = sni;

    if (!decision.allowed) {
      recordDenial(host, decision, { port, repoHash, sni });

      client.destroy();

      return;
    }

    if (client.destroyed) {
      return;
    }

    const upstream = await dialUpstream(connection);

    if (upstream === undefined) {
      client.destroy();

      return;
    }

    track(upstream);

    if (client.destroyed) {
      upstream.destroy();

      return;
    }

    upstream.on("error", () => client.destroy());

    client.once("close", () => upstream.destroy());

    splice(connection, upstream, hello);
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

    if (!decision.allowed && HINTED_RULES.has(decision.rule) && head.length === 0) {
      await showDenial(client, host, decision, { port: target.port, repoHash: caller.repoHash });

      return;
    }

    if (!decision.allowed) {
      refuse(client, host, decision, { port: target.port, repoHash: caller.repoHash });

      return;
    }

    const connection: Connection = { host, port: target.port, repoHash: caller.repoHash, extras, client };
    const terminated =
      isGatewayTarget(host, target.port) ||
      isRuleHost(await options.runtime.rules(caller.repoHash), host, target.port) ||
      (await options.vault?.isVaultHost(host, target.port, caller.repoHash)) === true;

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

  const sendJsonAndClose = (response: ServerResponse, status: number, body: object) => {
    response.once("finish", () => response.socket?.destroySoon());

    sendJson(response, status, body, { connection: "close" });
  };

  const challenge = (response: ServerResponse) =>
    sendJson(response, 407, { error: AUTH_DENIAL.reason }, { "proxy-authenticate": AUTH_CHALLENGE });

  const handleControl = async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(request);

    if (body.overflow) {
      sendJsonAndClose(response, 400, { ok: false, error: "control message too large" });

      return;
    }

    const message = parseControlMessage(body.text);

    if (message === undefined) {
      sendJson(response, 400, { ok: false, error: "unknown control message" });

      return;
    }

    const reply = (await options.onControl?.(message)) ?? {
      ok: false,
      error: "control messages are not accepted",
    };

    sendJson(response, reply.ok ? 200 : 400, reply);
  };

  const sendReply = (response: ServerResponse, reply: VaultReply) => {
    if (reply.body === undefined) {
      response.writeHead(reply.status, { "proxy-agent": PROXY_AGENT });

      response.end();

      return;
    }

    sendJson(response, reply.status, reply.body);
  };

  const oauthReply = async (
    request: IncomingMessage,
    response: ServerResponse,
    vault: VaultHook,
    repoHash: string,
  ): Promise<VaultReply & { close?: boolean }> => {
    const path = pathOf(request.url);

    if (request.method === "POST" && path === OAUTH_ROUTES.open) {
      const body = await readBody(request);

      if (body.overflow) {
        return { status: 413, body: { ok: false, error: "pi-sandbox: request body too large" }, close: true };
      }

      return vault.open(repoHash, parseJsonBody(body.text));
    }

    if (request.method === "GET" && path === OAUTH_ROUTES.callback) {
      const abort = new AbortController();

      response.once("close", () => abort.abort());

      return vault.callback(repoHash, flowOf(request.url), abort.signal);
    }

    if (request.method === "POST" && path === OAUTH_ROUTES.cancel) {
      return vault.cancel(repoHash, flowOf(request.url));
    }

    return { status: 405, body: { ok: false, error: "pi-sandbox: method not allowed" } };
  };

  const handleOAuth = async (request: IncomingMessage, response: ServerResponse, caller: Caller) => {
    if (caller.kind !== "repo") {
      sendJson(response, 403, {
        ok: false,
        error: "pi-sandbox: sign-in routes need the sandbox's proxy token",
      });

      return;
    }

    if (options.vault === undefined) {
      sendJson(response, 404, { ok: false, error: "pi-sandbox: sign-in from the sandbox is not enabled" });

      return;
    }

    const reply = await oauthReply(request, response, options.vault, caller.repoHash);

    if (reply.close === true) {
      sendJsonAndClose(response, reply.status, reply.body ?? {});

      return;
    }

    sendReply(response, reply);
  };

  const handlePlain = async (request: IncomingMessage, response: ServerResponse) => {
    const caller = await callerOf(request);
    const path = pathOf(request.url);

    if (caller === undefined || (path === "/control" && caller.kind !== "control")) {
      recordDenial(hostOf(request.headers.host), AUTH_DENIAL);

      challenge(response);

      return;
    }

    if (OAUTH_PATHS.has(path)) {
      await handleOAuth(request, response, caller);

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

  const port = (server.address() as AddressInfo).port;

  const listenAlso = (host: string) =>
    new Promise<NetServer | undefined>((resolve) => {
      const extra = createNetServer((socket) => server.emit("connection", socket));

      extra.once("error", (error) => {
        options.onListenError?.(`proxy cannot also listen on ${host}:${port}: ${error.message}`);

        resolve(undefined);
      });

      extra.listen(port, host, () => resolve(extra));
    });

  const extras = await Promise.all((options.listen.extraHosts ?? []).map(listenAlso));

  const close = async () => {
    await options.vault?.close();

    await new Promise<void>((resolve) => {
      sockets.forEach((socket) => {
        socket.destroy();
      });

      server.closeAllConnections();

      extras.forEach((extra) => {
        extra?.close();
      });

      server.close(() => resolve());
    });
  };

  return { port, policyHash, close };
};
