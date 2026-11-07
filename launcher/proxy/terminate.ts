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
import {
  type HeaderPair,
  matchRules,
  rewriteRequestHeaders,
  ruleApplies,
  type ScrubSecret,
  scrubResponseHeaders,
  transformSecret,
} from "./rules.ts";
import type { SecretResolver } from "./secrets/index.ts";

export interface TerminatedTarget {
  host: string;
  port: number;
  repoHash: string;
  access: DialAccess;
  pathPrefix?: string;
}

export interface TerminatorOptions {
  rules: () => Promise<CredentialRule[]>;
  resolver: SecretResolver;
  dial: Dialer;
  upstreamCa?: string | string[];
  log: (entry: Omit<AccessLogEntry, "time" | "user">) => void;
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
    if (!ruleApplies(state.headers, rule)) {
      return state;
    }

    const result = await options.resolver.resolve(rule.id, rule.secret);
    const injected = result.ok ? transformSecret(rule, result.value) : undefined;

    if (!result.ok || injected === undefined) {
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

      return { ...state, headers: rewriteRequestHeaders(state.headers, rule, undefined) };
    }

    return {
      headers: rewriteRequestHeaders(state.headers, rule, injected),
      secrets: [
        ...state.secrets,
        { value: result.value, placeholder: rule.placeholder },
        { value: injected, placeholder: rule.placeholder },
      ],
      used: [...state.used, rule.id],
    };
  };

  const applyRules = async (incoming: IncomingMessage, target: TerminatedTarget, upgrade: boolean) => {
    const matching = matchRules(await options.rules(), target.host, target.port, incoming.url ?? "/");
    const initial: Applied = {
      headers: forwardedPairs(incoming.rawHeaders, incoming.headers, upgrade),
      secrets: [],
      used: [],
    };

    return matching.reduce<Promise<Applied>>(
      async (state, rule) => applyRule(await state, rule, target),
      Promise.resolve(initial),
    );
  };

  const upstreamSocket = async (target: TerminatedTarget) => {
    const socket = await options.dial(target.host, target.port, target.access);

    return tlsConnect({
      socket,
      servername: target.host,
      ca: options.upstreamCa,
      ALPNProtocols: ["http/1.1"],
    });
  };

  const open = async (incoming: IncomingMessage, target: TerminatedTarget, upgrade: boolean) => {
    const applied = await applyRules(incoming, target, upgrade);
    const secure = await upstreamSocket(target);
    const request = httpsRequest({
      hostname: target.host,
      port: target.port,
      method: incoming.method,
      path: upstreamPath(target.pathPrefix, incoming.url),
      headers: headerObject(
        applied.headers,
        target.port === 443 ? target.host : `${target.host}:${target.port}`,
      ),
      createConnection: () => secure,
    });

    return { request, applied };
  };

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

  const forward = async (incoming: IncomingMessage, response: ServerResponse) => {
    const target = targets.get(incoming.socket);

    if (target === undefined) {
      response.destroy();

      return;
    }

    const opened = await open(incoming, target, false).catch((error: unknown) => error as Error);

    if (opened instanceof Error) {
      failure(response, opened);

      return;
    }

    relay(opened.request, incoming, response, opened.applied);
  };

  const forwardUpgrade = async (incoming: IncomingMessage, client: Duplex, head: Buffer) => {
    const target = targets.get(incoming.socket);
    const opened =
      target === undefined ? undefined : await open(incoming, target, true).catch(() => undefined);

    if (opened === undefined) {
      client.destroy();

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

    request.end();
  };

  const server = createServer((incoming, response) => {
    void forward(incoming, response);
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
