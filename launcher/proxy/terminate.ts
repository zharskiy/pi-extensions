import {
  type ClientRequest,
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { type Duplex, pipeline } from "node:stream";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { authorityOf, type CredentialRule } from "../config/index.ts";
import type { Denials } from "./denials.ts";
import { type Dial, type DialAccess, RestrictedAddressError } from "./dial.ts";
import { PROXY_AGENT, rawHead, rawReply, rawResponse, statusLine } from "./replies.ts";
import { parseRequestTarget } from "./request-target.ts";
import {
  type HeaderPair,
  matchRules,
  rewriteRequestHeaders,
  ruleApplies,
  rulesOfHost,
  type ScrubSecret,
  scrubResponseHeaders,
  withoutOtherPlaceholders,
  withoutStrayPlaceholders,
} from "./rules.ts";
import type { SecretReply, SecretResolver, SecretResult } from "./secrets/index.ts";

export interface TerminatedTarget {
  host: string;
  port: number;
  access: DialAccess;
}

export interface TerminatorOptions {
  rules: () => CredentialRule[];
  resolver: SecretResolver;
  dial: Dial;
  upstreamCa?: string | string[];
  note: Denials["note"];
}

interface Applied {
  headers: HeaderPair[];
  secrets: ScrubSecret[];
  used: Array<{ rule: CredentialRule; value: string | undefined }>;
  reply?: SecretReply;
}

interface LocalReply {
  status: number;
  headers: HeaderPair[];
  body: Buffer;
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

const HEADER_BREAK = /[\r\n\0]/;

const IDLE_MS = 4_000;

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

const statusBlock = (upstream: IncomingMessage, pairs: HeaderPair[]) =>
  rawHead(statusLine(upstream.statusCode ?? 502, upstream.statusMessage), pairs);

const sendLocal = (response: ServerResponse, reply: LocalReply, extra: HeaderPair[] = []) => {
  response.writeHead(
    reply.status,
    [...reply.headers, ...extra, ["content-length", String(reply.body.length)]].flat(),
  );

  response.end(reply.body);
};

const localOf = (reply: SecretReply): LocalReply => ({
  status: reply.status,
  headers: [...Object.entries(reply.headers), ["proxy-agent", PROXY_AGENT]],
  body: Buffer.from(reply.body),
});

const errorReply = (status: number, error: string): LocalReply => ({
  status,
  headers: [
    ["content-type", "application/json"],
    ["proxy-agent", PROXY_AGENT],
  ],
  body: Buffer.from(JSON.stringify({ error })),
});

const sendAndClose = (response: ServerResponse, status: number, error: string) => {
  response.once("finish", () => response.socket?.destroySoon());

  sendLocal(response, errorReply(status, error), [["connection", "close"]]);
};

const rawError = (client: Duplex, status: number, error: string) => {
  client.end(rawReply(statusLine(status), { error }));
};

const rawLocal = (client: Duplex, reply: SecretReply) => {
  client.end(
    rawResponse(
      statusLine(reply.status),
      [...Object.entries(reply.headers), ["proxy-agent", PROXY_AGENT]],
      reply.body,
    ),
  );
};

const poolKey = (target: TerminatedTarget) => `${target.host}|${target.port}|${target.access}`;

const CERTIFICATE_ERROR = /certificate|self[- ]signed|issuer|CERT_/i;

const CERTIFICATE_HINT = "; if a proxy or CA on this network signs this host, set tls.extraCa to its CA";

const failureReason = (error: unknown) => {
  const message = (error as Error).message;

  return `${message}${CERTIFICATE_ERROR.test(message) ? CERTIFICATE_HINT : ""}`;
};

const upstreamFailure = (error: unknown) => `upstream request failed: ${failureReason(error)}`;

const framingOf = (incoming: IncomingMessage): HeaderPair[] =>
  incoming.headers["transfer-encoding"] === undefined ? [] : [["transfer-encoding", "chunked"]];

const failure = (response: ServerResponse, error: unknown) => {
  if (response.headersSent) {
    response.destroy();

    return;
  }

  const body = JSON.stringify({ error: upstreamFailure(error) });

  response.writeHead(502, { "content-type": "application/json", "proxy-agent": PROXY_AGENT });

  response.end(body);
};

const credentialDenial = (rule: CredentialRule, result: SecretResult) => {
  if (!result.ok) {
    return result.login === true
      ? { rule: "login", reason: result.reason }
      : { rule: "credential", reason: `credential ${rule.id} is unavailable: ${result.reason}` };
  }

  return {
    rule: "credential",
    reason: `credential ${rule.id} is unavailable: the secret holds a line break`,
  };
};

export const createTerminator = (options: TerminatorOptions) => {
  const targets = new WeakMap<object, TerminatedTarget>();
  const agents = new Map<string, Agent>();

  const noteFailure = (target: TerminatedTarget, error: unknown) => {
    const rule = error instanceof RestrictedAddressError ? error.rule : "upstream";

    options.note(target.host, { rule, reason: failureReason(error) }, { port: target.port });
  };

  const fail = (target: TerminatedTarget, response: ServerResponse, error: unknown) => {
    if (!response.headersSent) {
      noteFailure(target, error);
    }

    failure(response, error);
  };

  const applyRule = async (
    state: Applied,
    rule: CredentialRule,
    target: TerminatedTarget,
  ): Promise<Applied> => {
    const headers = withoutStrayPlaceholders(state.headers, rule);

    if (!ruleApplies(headers, rule)) {
      return { ...state, headers };
    }

    const result = await options.resolver.resolve(rule.id, rule.secret);
    const injected = result.ok ? result.value : undefined;

    if (!result.ok && result.reply !== undefined) {
      return { ...state, headers, reply: state.reply ?? result.reply };
    }

    if (!result.ok || injected === undefined || HEADER_BREAK.test(injected)) {
      options.note(target.host, credentialDenial(rule, result), {
        port: target.port,
        credentialRule: rule.id,
      });

      return {
        ...state,
        headers: rewriteRequestHeaders(headers, rule, undefined).headers,
        used: [...state.used, { rule, value: undefined }],
      };
    }

    const rewritten = rewriteRequestHeaders(headers, rule, injected);

    return {
      ...state,
      headers: rewritten.headers,
      secrets: [...state.secrets, { value: injected, placeholder: rule.placeholder }, ...rewritten.secrets],
      used: [...state.used, { rule, value: result.value }],
    };
  };

  const applyRules = async (pairs: HeaderPair[], target: TerminatedTarget, path: string) => {
    const rules = options.rules();
    const matching = matchRules(rules, target.host, target.port, path);
    const headers = withoutOtherPlaceholders(pairs, rulesOfHost(rules, target.host), matching);
    const initial: Applied = { headers, secrets: [], used: [] };

    return matching.reduce<Promise<Applied>>(async (pending, rule) => {
      const state = await pending;

      return state.reply === undefined ? applyRule(state, rule, target) : state;
    }, Promise.resolve(initial));
  };

  const upstreamSocket = async (target: TerminatedTarget) => {
    const socket = await options.dial(target.host, target.port, target.access);
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

  const agentFor = (target: TerminatedTarget) => {
    const key = poolKey(target);
    const known = agents.get(key);

    if (known !== undefined) {
      return known;
    }

    const agent = new Agent({ keepAlive: true, timeout: IDLE_MS });

    agent.createConnection = (_options, callback) => {
      void upstreamSocket(target).then(
        (secure) => callback?.(null, secure),
        (error: Error) => callback?.(error, undefined as never),
      );

      return undefined;
    };

    agents.set(key, agent);

    return agent;
  };

  const requestOptions = (
    target: TerminatedTarget,
    method: string | undefined,
    path: string,
    headers: HeaderPair[],
  ) => ({
    hostname: target.host,
    port: target.port,
    method,
    path,
    headers: headerObject(headers, authorityOf(target.host, target.port)),
  });

  const pooledRequest = async (
    target: TerminatedTarget,
    method: string | undefined,
    path: string,
    headers: HeaderPair[],
  ) => httpsRequest({ ...requestOptions(target, method, path, headers), agent: agentFor(target) });

  const freshRequest = async (
    target: TerminatedTarget,
    method: string | undefined,
    path: string,
    headers: HeaderPair[],
  ) => {
    const secure = await upstreamSocket(target);

    try {
      return httpsRequest({
        ...requestOptions(target, method, path, headers),
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
    upgrade = false,
  ) => {
    const applied = await applyRules(pairs, target, routed.decodedPath);
    const reply = applied.reply;

    if (reply !== undefined) {
      return { reply };
    }

    const send = upgrade ? freshRequest : pooledRequest;
    const request = await send(target, method, routed.path, applied.headers);

    return { request, applied };
  };

  const open = (incoming: IncomingMessage, target: TerminatedTarget, routed: RoutedPath, upgrade: boolean) =>
    openWith(
      target,
      incoming.method,
      routed,
      [
        ...forwardedPairs(incoming.rawHeaders, incoming.headers, upgrade),
        ...(upgrade ? [] : framingOf(incoming)),
      ],
      upgrade,
    );

  const afterResponse = async (upstream: IncomingMessage, applied: Applied) => {
    if (upstream.statusCode !== UNAUTHORIZED) {
      return undefined;
    }

    applied.used
      .filter(({ value }) => value !== undefined)
      .forEach(({ rule }) => {
        options.resolver.invalidate(rule.id);
      });

    const replies = await Promise.all(
      applied.used.map(({ rule, value }) => options.resolver.rejected(rule.id, rule.secret, value)),
    );

    return replies.find((reply) => reply !== undefined);
  };

  const responsePairs = (upstream: IncomingMessage, applied: Applied) =>
    scrubResponseHeaders(forwardedPairs(upstream.rawHeaders, upstream.headers, false), applied.secrets);

  const relay = (
    target: TerminatedTarget,
    request: ClientRequest,
    incoming: IncomingMessage,
    response: ServerResponse,
    applied: Applied,
  ) => {
    request.on("response", (upstream) => {
      void afterResponse(upstream, applied)
        .then((reply) => {
          if (reply !== undefined) {
            upstream.resume();

            sendLocal(response, localOf(reply));

            return;
          }

          response.writeHead(
            upstream.statusCode ?? 502,
            upstream.statusMessage,
            responsePairs(upstream, applied).flat(),
          );

          response.flushHeaders();

          pipeline(upstream, response, () => undefined);
        })
        .catch(() => response.destroy());
    });

    const client = { gone: false };

    request.on("error", (error) => {
      if (!client.gone) {
        fail(target, response, error);
      }
    });

    response.on("close", () => {
      client.gone = true;

      request.destroy();
    });

    incoming.pipe(request);
  };

  const routedTarget = (incoming: IncomingMessage) => {
    const target = targets.get(incoming.socket);

    return target === undefined
      ? undefined
      : { target, routed: parseRequestTarget(incoming.url, target.host, target.port) };
  };

  const forward = async (incoming: IncomingMessage, response: ServerResponse) => {
    const found = routedTarget(incoming);

    if (found === undefined) {
      response.destroy();

      return;
    }

    const { target, routed } = found;

    if (!routed.ok) {
      sendAndClose(response, 400, routed.reason);

      return;
    }

    const opened = await open(incoming, target, routed, false).catch((error: unknown) => error as Error);

    if (opened instanceof Error) {
      fail(target, response, opened);

      return;
    }

    if (opened.reply !== undefined) {
      incoming.resume();

      sendLocal(response, localOf(opened.reply));

      return;
    }

    relay(target, opened.request, incoming, response, opened.applied);
  };

  const forwardUpgrade = async (incoming: IncomingMessage, client: Duplex, head: Buffer) => {
    const found = routedTarget(incoming);

    if (found === undefined) {
      client.destroy();

      return;
    }

    const { target, routed } = found;

    if (!routed.ok) {
      rawError(client, 400, routed.reason);

      return;
    }

    const opened = await open(incoming, target, routed, true).catch((error: unknown) => error as Error);

    if (opened instanceof Error) {
      noteFailure(target, opened);

      rawError(client, 502, "pi-sandbox: upstream request failed");

      return;
    }

    if (opened.reply !== undefined) {
      rawLocal(client, opened.reply);

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
      void afterResponse(upstream, applied)
        .then((reply) => {
          if (reply !== undefined) {
            upstream.resume();

            rawLocal(client, reply);

            upstream.socket.destroy();

            return;
          }

          const pairs = responsePairs(upstream, applied).filter(
            ([name]) => name.toLowerCase() !== "content-length",
          );

          client.write(statusBlock(upstream, [...pairs, ["connection", "close"]]));

          pipeline(upstream, client, () => upstream.socket.destroy());
        })
        .catch(() => client.destroy());
    });

    request.on("error", (error) => {
      if (!client.destroyed) {
        noteFailure(target, error);
      }

      client.destroy();
    });

    client.on("error", () => request.destroy());

    request.end();
  };

  const server = createServer((incoming, response) => {
    void forward(incoming, response).catch((error: unknown) => failure(response, error));
  });

  server.on("upgrade", (incoming: IncomingMessage, client: Duplex, head: Buffer) => {
    void forwardUpgrade(incoming, client, head).catch(() => client.destroy());
  });

  const serve = (socket: TLSSocket, target: TerminatedTarget) => {
    targets.set(socket, target);

    server.emit("connection", socket);
  };

  const close = () => {
    agents.forEach((agent) => {
      agent.destroy();
    });

    agents.clear();
  };

  return { serve, close };
};
