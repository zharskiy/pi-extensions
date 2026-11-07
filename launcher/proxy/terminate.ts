import {
  type ClientRequest,
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import type { CredentialRule } from "../config/index.ts";
import type { AccessLogEntry } from "./access-log.ts";
import type { DialAccess, Dialer } from "./dial.ts";
import { parseRequestTarget } from "./request-target.ts";
import {
  type HeaderPair,
  matchRules,
  rewriteRequestHeaders,
  ruleApplies,
  type ScrubSecret,
  scrubResponseHeaders,
  transformSecret,
  withoutStrayPlaceholders,
} from "./rules.ts";
import type { SecretResolver } from "./secrets/index.ts";
import type { TokenPlan, TokenResponse, VaultTokenHook } from "./vault/index.ts";

export interface TerminatedTarget {
  host: string;
  port: number;
  repoHash: string;
  access: DialAccess;
  pathPrefix?: string;
}

export interface TerminatorOptions {
  rules: (repoHash: string) => Promise<CredentialRule[]>;
  resolver: SecretResolver;
  dial: Dialer;
  upstreamCa?: string | string[];
  log: (entry: Omit<AccessLogEntry, "time" | "user">) => void;
  vault?: VaultTokenHook;
}

interface Applied {
  headers: HeaderPair[];
  secrets: ScrubSecret[];
  used: string[];
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const UPGRADE_HEADERS = new Set(["connection", "upgrade"]);

const UNAUTHORIZED = 401;

const MAX_FORM_BYTES = 64 * 1024;

const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024;

const BUFFERED_DROPPED = new Set(["accept-encoding", "content-length"]);

const RESPONSE_DROPPED = new Set(["content-length", "content-encoding"]);

const HEADER_BREAK = /[\r\n\0]/;

interface RoutedPath {
  path: string;
  decodedPath: string;
}

const connectionTokens = (headers: IncomingHttpHeaders) =>
  new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== "" && !UPGRADE_HEADERS.has(token)),
  );

const isForwarded = (name: string, dropped: Set<string>, keepUpgrade: boolean) =>
  (keepUpgrade && UPGRADE_HEADERS.has(name)) || (!HOP_BY_HOP.has(name) && !dropped.has(name));

const rawPairs = (raw: string[]): HeaderPair[] =>
  raw.filter((_, index) => index % 2 === 0).map((name, index) => [name, raw[index * 2 + 1] ?? ""] as const);

const forwardedPairs = (raw: string[], headers: IncomingHttpHeaders, keepUpgrade: boolean) => {
  const dropped = connectionTokens(headers);

  return rawPairs(raw).filter(([name]) => isForwarded(name.toLowerCase(), dropped, keepUpgrade));
};

const headerObject = (pairs: HeaderPair[], host: string) =>
  pairs.reduce<Record<string, string | string[]>>(
    (headers, [name, value]) => {
      const key = name.toLowerCase();
      const existing = headers[key];

      headers[key] = existing === undefined ? value : [existing, value].flat();

      return headers;
    },
    { host },
  );

const upstreamPath = (prefix: string | undefined, path: string | undefined) =>
  `${(prefix ?? "").replace(/\/$/, "")}${path ?? "/"}`;

const statusBlock = (upstream: IncomingMessage, pairs: HeaderPair[]) => {
  const lines = pairs.map(([name, value]) => `${name}: ${value}`);

  return [`HTTP/1.1 ${upstream.statusCode} ${upstream.statusMessage}`, ...lines, "", ""].join("\r\n");
};

const collect = (stream: IncomingMessage, limit: number) =>
  new Promise<Buffer | undefined>((resolve) => {
    const chunks: Buffer[] = [];
    const state = { size: 0 };

    const onData = (chunk: Buffer) => {
      state.size += chunk.length;

      if (state.size > limit) {
        stream.off("data", onData);

        stream.pause();

        resolve(undefined);

        return;
      }

      chunks.push(chunk);
    };

    stream.on("data", onData);

    stream.once("end", () => resolve(Buffer.concat(chunks)));

    stream.once("error", () => resolve(undefined));
  });

const isEventStream = (message: IncomingMessage) =>
  String(message.headers["content-type"] ?? "")
    .toLowerCase()
    .startsWith("text/event-stream");

const isEncoded = (message: IncomingMessage) => {
  const encoding = String(message.headers["content-encoding"] ?? "identity")
    .trim()
    .toLowerCase();

  return encoding !== "" && encoding !== "identity";
};

const sendBuffered = (response: ServerResponse, reply: TokenResponse, extra: HeaderPair[] = []) => {
  const pairs = reply.headers.filter(([name]) => !RESPONSE_DROPPED.has(name.toLowerCase()));

  response.writeHead(
    reply.status,
    [...pairs, ...extra, ["content-length", String(reply.body.length)]].flat(),
  );

  response.end(reply.body);
};

const errorReply = (status: number, error: string): TokenResponse => ({
  status,
  headers: [
    ["content-type", "application/json"],
    ["proxy-agent", "pi-sandbox"],
  ],
  body: Buffer.from(JSON.stringify({ error })),
});

const sendError = (response: ServerResponse, status: number, error: string) =>
  sendBuffered(response, errorReply(status, error));

const sendAndClose = (response: ServerResponse, status: number, error: string) => {
  response.once("finish", () => response.socket?.destroySoon());

  sendBuffered(response, errorReply(status, error), [["connection", "close"]]);
};

const rawError = (client: Duplex, status: string, error: string) => {
  const body = JSON.stringify({ error });

  client.end(
    [
      `HTTP/1.1 ${status}`,
      "content-type: application/json",
      `content-length: ${Buffer.byteLength(body)}`,
      "connection: close",
      "",
      body,
    ].join("\r\n"),
  );
};

const authorityOf = (target: TerminatedTarget) =>
  target.port === 443 ? target.host : `${target.host}:${target.port}`;

const absoluteUrl = (target: TerminatedTarget, path: string) =>
  `https://${authorityOf(target)}${upstreamPath(target.pathPrefix, path)}`;

const failure = (response: ServerResponse, error: unknown) => {
  if (response.headersSent) {
    response.destroy();

    return;
  }

  const body = JSON.stringify({ error: `upstream request failed: ${(error as Error).message}` });

  response.writeHead(502, { "content-type": "application/json", "proxy-agent": "pi-sandbox" });

  response.end(body);
};

export const createTerminator = (options: TerminatorOptions) => {
  const targets = new WeakMap<object, TerminatedTarget>();

  const applyRule = async (
    state: Applied,
    rule: CredentialRule,
    target: TerminatedTarget,
  ): Promise<Applied> => {
    const headers = withoutStrayPlaceholders(state.headers, rule);

    if (!ruleApplies(headers, rule)) {
      return { ...state, headers };
    }

    const result = await options.resolver.resolve(rule.id, rule.secret, target.repoHash);
    const injected = result.ok ? transformSecret(rule, result.value) : undefined;

    if (!result.ok || injected === undefined || HEADER_BREAK.test(injected)) {
      options.log({
        repo: target.repoHash,
        host: target.host,
        decision: "allow",
        rule: "credential",
        reason: "unavailable",
        credential: rule.id,
        bytesIn: 0,
        bytesOut: 0,
      });

      return { ...state, headers: rewriteRequestHeaders(headers, rule, undefined) };
    }

    return {
      headers: rewriteRequestHeaders(headers, rule, injected),
      secrets: [
        ...state.secrets,
        { value: result.value, placeholder: rule.placeholder },
        { value: injected, placeholder: rule.placeholder },
      ],
      used: [...state.used, rule.id],
    };
  };

  const applyRules = async (pairs: HeaderPair[], target: TerminatedTarget, path: string) => {
    const matching = matchRules(await options.rules(target.repoHash), target.host, target.port, path);
    const initial: Applied = { headers: pairs, secrets: [], used: [] };

    return matching.reduce<Promise<Applied>>(
      async (state, rule) => applyRule(await state, rule, target),
      Promise.resolve(initial),
    );
  };

  const upstreamSocket = async (target: TerminatedTarget) => {
    const socket = await options.dial(target.host, target.port, target.access, target.repoHash);
    const secure = tlsConnect({
      socket,
      servername: target.host,
      ca: options.upstreamCa,
      ALPNProtocols: ["http/1.1"],
    });

    socket.on("error", () => secure.destroy());

    secure.on("error", () => secure.destroy());

    return secure;
  };

  const requestOver = (
    secure: TLSSocket,
    target: TerminatedTarget,
    method: string | undefined,
    path: string,
    headers: HeaderPair[],
  ) => {
    try {
      return httpsRequest({
        hostname: target.host,
        port: target.port,
        method,
        path: upstreamPath(target.pathPrefix, path),
        headers: headerObject(headers, authorityOf(target)),
        createConnection: () => secure,
      });
    } catch (error) {
      secure.destroy();

      throw error;
    }
  };

  const openWith = async (
    target: TerminatedTarget,
    method: string | undefined,
    routed: RoutedPath,
    pairs: HeaderPair[],
  ) => {
    const applied = await applyRules(pairs, target, routed.decodedPath);
    const secure = await upstreamSocket(target);
    const request = requestOver(secure, target, method, routed.path, applied.headers);

    return { request, applied };
  };

  const open = (incoming: IncomingMessage, target: TerminatedTarget, routed: RoutedPath, upgrade: boolean) =>
    openWith(target, incoming.method, routed, forwardedPairs(incoming.rawHeaders, incoming.headers, upgrade));

  const afterResponse = (upstream: IncomingMessage, applied: Applied) => {
    if (upstream.statusCode === UNAUTHORIZED) {
      applied.used.forEach((id) => {
        options.resolver.invalidate(id);
      });
    }
  };

  const responsePairs = (upstream: IncomingMessage, applied: Applied) =>
    scrubResponseHeaders(forwardedPairs(upstream.rawHeaders, upstream.headers, false), applied.secrets);

  const relay = (
    request: ClientRequest,
    incoming: IncomingMessage,
    response: ServerResponse,
    applied: Applied,
  ) => {
    request.on("response", (upstream) => {
      afterResponse(upstream, applied);

      response.writeHead(
        upstream.statusCode ?? 502,
        upstream.statusMessage,
        responsePairs(upstream, applied).flat(),
      );

      response.flushHeaders();

      upstream.pipe(response);
    });

    request.on("error", (error) => failure(response, error));

    response.on("close", () => request.destroy());

    incoming.pipe(request);
  };

  const logVault = (target: TerminatedTarget, reason: string | undefined) => {
    if (reason !== undefined) {
      options.log({
        repo: target.repoHash,
        host: target.host,
        decision: "allow",
        rule: "vault",
        reason,
        bytesIn: 0,
        bytesOut: 0,
      });
    }
  };

  const completeBuffered = async (
    upstream: IncomingMessage,
    response: ServerResponse,
    target: TerminatedTarget,
    plan: Extract<TokenPlan, { kind: "forward" }>,
    applied: Applied,
  ) => {
    afterResponse(upstream, applied);

    if (isEventStream(upstream) && plan.strict !== true) {
      response.writeHead(upstream.statusCode ?? 502, responsePairs(upstream, applied).flat());

      upstream.pipe(response);

      return;
    }

    if (isEncoded(upstream)) {
      upstream.resume();

      sendError(response, 502, "pi-sandbox: compressed token response refused");

      return;
    }

    const body = await collect(upstream, MAX_TOKEN_RESPONSE_BYTES);

    if (body === undefined) {
      upstream.destroy();

      sendError(response, 502, "pi-sandbox: token response too large");

      return;
    }

    const outcome = await plan.complete({
      status: upstream.statusCode ?? 502,
      headers: responsePairs(upstream, applied),
      body,
    });

    logVault(target, outcome.reason);

    sendBuffered(response, outcome.response);
  };

  const forwardBuffered = async (
    incoming: IncomingMessage,
    response: ServerResponse,
    target: TerminatedTarget,
    routed: RoutedPath,
    vault: VaultTokenHook,
  ) => {
    const body = await collect(incoming, MAX_FORM_BYTES);

    if (body === undefined) {
      sendAndClose(response, 413, "pi-sandbox: request body too large");

      return;
    }

    const pairs = forwardedPairs(incoming.rawHeaders, incoming.headers, false).filter(
      ([name]) => !BUFFERED_DROPPED.has(name.toLowerCase()),
    );
    const plan = await vault.plan({
      repoHash: target.repoHash,
      url: absoluteUrl(target, routed.path),
      headers: pairs,
      body,
    });

    logVault(target, plan.reason);

    if (plan.kind === "answer") {
      sendBuffered(response, plan.response);

      return;
    }

    const { request, applied } = await openWith(target, incoming.method, routed, [
      ...plan.headers,
      ["content-length", String(plan.body.length)],
    ]);

    request.on("response", (upstream) => {
      void completeBuffered(upstream, response, target, plan, applied).catch((error: unknown) =>
        failure(response, error),
      );
    });

    request.on("error", (error) => failure(response, error));

    response.on("close", () => request.destroy());

    request.end(plan.body);
  };

  const buffersFor = async (incoming: IncomingMessage, target: TerminatedTarget, routed: RoutedPath) =>
    options.vault !== undefined &&
    (await options.vault.buffers({
      host: target.host,
      port: target.port,
      repoHash: target.repoHash,
      method: incoming.method ?? "GET",
      url: absoluteUrl(target, routed.path),
      contentType: String(incoming.headers["content-type"] ?? ""),
    }));

  const forward = async (incoming: IncomingMessage, response: ServerResponse) => {
    const target = targets.get(incoming.socket);

    if (target === undefined) {
      response.destroy();

      return;
    }

    const routed = parseRequestTarget(incoming.url, target.host, target.port);

    if (!routed.ok) {
      sendAndClose(response, 400, routed.reason);

      return;
    }

    if (options.vault !== undefined && (await buffersFor(incoming, target, routed))) {
      await forwardBuffered(incoming, response, target, routed, options.vault).catch((error: unknown) =>
        failure(response, error),
      );

      return;
    }

    const opened = await open(incoming, target, routed, false).catch((error: unknown) => error as Error);

    if (opened instanceof Error) {
      failure(response, opened);

      return;
    }

    relay(opened.request, incoming, response, opened.applied);
  };

  const forwardUpgrade = async (incoming: IncomingMessage, client: Duplex, head: Buffer) => {
    const target = targets.get(incoming.socket);

    if (target === undefined) {
      client.destroy();

      return;
    }

    const routed = parseRequestTarget(incoming.url, target.host, target.port);

    if (!routed.ok) {
      rawError(client, "400 Bad Request", routed.reason);

      return;
    }

    const opened = await open(incoming, target, routed, true).catch(() => undefined);

    if (opened === undefined) {
      rawError(client, "502 Bad Gateway", "pi-sandbox: upstream request failed");

      return;
    }

    const { request, applied } = opened;

    request.on("upgrade", (upstream, socket, upstreamHead) => {
      client.write(
        statusBlock(upstream, scrubResponseHeaders(rawPairs(upstream.rawHeaders), applied.secrets)),
      );

      client.write(upstreamHead);

      socket.write(head);

      socket.pipe(client).pipe(socket);

      socket.on("error", () => client.destroy());

      client.on("error", () => socket.destroy());
    });

    request.on("response", (upstream) => {
      afterResponse(upstream, applied);

      const pairs = responsePairs(upstream, applied).filter(
        ([name]) => name.toLowerCase() !== "content-length",
      );

      client.write(statusBlock(upstream, [...pairs, ["connection", "close"]]));

      upstream.pipe(client);
    });

    request.on("error", () => client.destroy());

    client.on("error", () => request.destroy());

    request.end();
  };

  const server = createServer((incoming, response) => {
    void forward(incoming, response).catch((error: unknown) => failure(response, error));
  });

  server.on("upgrade", (incoming: IncomingMessage, client: Duplex, head: Buffer) => {
    void forwardUpgrade(incoming, client, head);
  });

  const serve = (socket: TLSSocket, target: TerminatedTarget) => {
    targets.set(socket, target);

    server.emit("connection", socket);
  };

  return { serve };
};
