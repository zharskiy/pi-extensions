import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import type { Credentials } from "./credentials.ts";
import type { Dialer } from "./dial.ts";

export interface GatewayRoute {
  host: string;
  url: string;
  authHeader: string;
  placeholder: string;
  credentials: Credentials;
}

interface GatewayForwarderOptions {
  route: GatewayRoute;
  dial: Dialer;
  upstreamCa?: string;
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

const connectionTokens = (headers: IncomingHttpHeaders) =>
  new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== "" && !UPGRADE_HEADERS.has(token)),
  );

const isForwarded = (name: string, dropped: Set<string>, keepUpgrade: boolean) =>
  (keepUpgrade && UPGRADE_HEADERS.has(name)) || (!HOP_BY_HOP.has(name) && !dropped.has(name));

const rawPairs = (raw: string[]) =>
  raw.filter((_, index) => index % 2 === 0).map((name, index) => [name, raw[index * 2 + 1] ?? ""] as const);

const forwardedPairs = (raw: string[], headers: IncomingHttpHeaders, keepUpgrade: boolean) => {
  const dropped = connectionTokens(headers);

  return rawPairs(raw).filter(([name]) => isForwarded(name.toLowerCase(), dropped, keepUpgrade));
};

const injectCredential = (value: string, placeholder: string, token: string) => {
  if (value === placeholder) {
    return token;
  }

  const [scheme, rest] = value.split(" ", 2);

  return rest === placeholder && value === `${scheme} ${rest}` ? `${scheme} ${token}` : value;
};

const carriesPlaceholder = (value: string, placeholder: string) =>
  value === placeholder || value.split(" ", 2)[1] === placeholder;

const requestHeaders = async (
  incoming: IncomingMessage,
  route: GatewayRoute,
  target: URL,
  upgrade: boolean,
) => {
  const authName = route.authHeader.toLowerCase();
  const pairs = forwardedPairs(incoming.rawHeaders, incoming.headers, upgrade);
  const needsToken = pairs.some(
    ([name, value]) => name.toLowerCase() === authName && carriesPlaceholder(value, route.placeholder),
  );
  const token = needsToken ? await route.credentials.token() : "";

  return pairs.reduce<Record<string, string | string[]>>(
    (headers, [name, value]) => {
      const key = name.toLowerCase();
      const forwarded =
        key === authName && needsToken ? injectCredential(value, route.placeholder, token) : value;
      const existing = headers[key];

      headers[key] = existing === undefined ? forwarded : [existing, forwarded].flat();

      return headers;
    },
    { host: target.host },
  );
};

const upstreamPath = (target: URL, path: string | undefined) =>
  `${target.pathname.replace(/\/$/, "")}${path ?? "/"}`;

const responsePairs = (upstream: IncomingMessage) =>
  forwardedPairs(upstream.rawHeaders, upstream.headers, false).flat();

const failure = (response: ServerResponse, error: unknown) => {
  if (response.headersSent) {
    response.destroy();

    return;
  }

  const body = JSON.stringify({ error: `gateway request failed: ${(error as Error).message}` });

  response.writeHead(502, { "content-type": "application/json", "proxy-agent": "pi-sandbox" });

  response.end(body);
};

const statusBlock = (upstream: IncomingMessage, pairs: ReadonlyArray<readonly [string, string]>) => {
  const lines = pairs.map(([name, value]) => `${name}: ${value}`);

  return [`HTTP/1.1 ${upstream.statusCode} ${upstream.statusMessage}`, ...lines, "", ""].join("\r\n");
};

export const createGatewayForwarder = ({ route, dial, upstreamCa }: GatewayForwarderOptions) => {
  const target = new URL(route.url);
  const port = Number(target.port || 443);

  const upstreamSocket = () =>
    tlsConnect({
      socket: dial(target.hostname, port, "gateway"),
      servername: target.hostname,
      ca: upstreamCa,
      ALPNProtocols: ["http/1.1"],
    });

  const open = async (incoming: IncomingMessage, upgrade: boolean) =>
    httpsRequest({
      hostname: target.hostname,
      port,
      method: incoming.method,
      path: upstreamPath(target, incoming.url),
      headers: await requestHeaders(incoming, route, target, upgrade),
      createConnection: upstreamSocket,
    });

  const forward = async (incoming: IncomingMessage, response: ServerResponse) => {
    const upstream = await open(incoming, false).catch((error: unknown) => error as Error);

    if (upstream instanceof Error) {
      failure(response, upstream);

      return;
    }

    upstream.on("response", (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        responsePairs(upstreamResponse),
      );

      response.flushHeaders();

      upstreamResponse.pipe(response);
    });

    upstream.on("error", (error) => failure(response, error));

    response.on("close", () => upstream.destroy());

    incoming.pipe(upstream);
  };

  const forwardUpgrade = async (incoming: IncomingMessage, client: Duplex, head: Buffer) => {
    const upstream = await open(incoming, true).catch(() => undefined);

    if (upstream === undefined) {
      client.destroy();

      return;
    }

    upstream.on("upgrade", (upstreamResponse, socket, upstreamHead) => {
      client.write(statusBlock(upstreamResponse, rawPairs(upstreamResponse.rawHeaders)));

      client.write(upstreamHead);

      socket.write(head);

      socket.pipe(client).pipe(socket);

      socket.on("error", () => client.destroy());

      client.on("error", () => socket.destroy());
    });

    upstream.on("response", (upstreamResponse) => {
      const pairs = forwardedPairs(upstreamResponse.rawHeaders, upstreamResponse.headers, false).filter(
        ([name]) => name.toLowerCase() !== "content-length",
      );

      client.write(statusBlock(upstreamResponse, [...pairs, ["connection", "close"]]));

      upstreamResponse.pipe(client);
    });

    upstream.on("error", () => client.destroy());

    upstream.end();
  };

  const server = createServer((incoming, response) => {
    void forward(incoming, response);
  });

  server.on("upgrade", (incoming: IncomingMessage, client: Duplex, head: Buffer) => {
    void forwardUpgrade(incoming, client, head);
  });

  return server;
};
