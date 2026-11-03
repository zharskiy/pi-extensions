import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { userInfo } from "node:os";
import type { Duplex } from "node:stream";
import { createSecureContext, TLSSocket } from "node:tls";
import { LauncherError, sha256Hex } from "../shared/index.ts";
import type { AccessLogEntry } from "./access-log.ts";
import { type Dialer, defaultDialer, RestrictedAddressError } from "./dial.ts";
import { createGatewayForwarder, type GatewayRoute } from "./gateway.ts";
import { type Denial, decideConnect, type EgressPolicy, isGatewayHost, normalizeHost } from "./policy.ts";
import { clientHelloRecordLength, parseServerName } from "./sni.ts";
import type { LeafCertificate } from "./tls-ca.ts";

export interface ProxyServerOptions {
  listen: { host: string; port: number };
  policy: EgressPolicy;
  policyHash?: string;
  token: string;
  gateway?: GatewayRoute;
  ca?: { leaf(host: string): Promise<LeafCertificate> };
  log: (entry: AccessLogEntry) => void;
  dial?: Dialer;
  upstreamCa?: string;
  helloTimeoutMs?: number;
}

export interface ProxyServer {
  port: number;
  policyHash: string;
  close(): Promise<void>;
}

interface Connection {
  host: string;
  sni?: string;
  client: Socket;
}

const PROXY_AGENT = "pi-sandbox";

const PROXY_USER = "pi-sandbox";

const AUTH_CHALLENGE = `Basic realm="${PROXY_AGENT}"`;

const AUTH_DENIAL = { rule: "auth", reason: "missing or wrong Proxy-Authorization" };

const HANDSHAKE_RECORD = 0x16;

const MAX_HELLO_BYTES = 16_389;

const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

const ESTABLISHED = `HTTP/1.1 200 Connection Established\r\nProxy-Agent: ${PROXY_AGENT}\r\n\r\n`;

const currentUser = () => {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
};

export const proxyAuthorization = (token: string) =>
  `Basic ${Buffer.from(`${PROXY_USER}:${token}`).toString("base64")}`;

export const guestProxyUrl = (route: { address: string }, token: string) =>
  `http://${PROXY_USER}:${token}@${route.address}`;

const sameText = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && timingSafeEqual(a, b);
};

const isAuthorized = (request: IncomingMessage, expected: string) => {
  const header = request.headers["proxy-authorization"];

  return typeof header === "string" && sameText(header.trim(), expected);
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

const denialBody = (host: string, denial: Pick<Denial, "rule" | "reason">) => ({
  denied: host,
  rule: denial.rule,
  reason: denial.reason,
});

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

const gatewayHandshakeDenial = (host: string, sni: string | undefined) => {
  if (sni === undefined) {
    return { rule: "sni", reason: "no TLS server name" };
  }

  const decision = decideConnect({ host, port: 443, sni }, { allow: [host], mcpHosts: [] });

  return decision.allowed ? { rule: "tls", reason: "TLS handshake with the client failed" } : decision;
};

export const startProxyServer = async (options: ProxyServerOptions): Promise<ProxyServer> => {
  const dial = options.dial ?? defaultDialer;
  const policyHash = options.policyHash ?? sha256Hex(JSON.stringify(options.policy));
  const user = currentUser();
  const sockets = new Set<Socket>();
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const expectedAuthorization = proxyAuthorization(options.token);

  const record = (entry: Omit<AccessLogEntry, "time" | "user">) => {
    options.log({ time: new Date().toISOString(), user, ...entry });
  };

  const recordDenial = (host: string, denial: Pick<Denial, "rule" | "reason">, sni?: string) => {
    record({
      host,
      sni,
      decision: "deny",
      rule: denial.rule,
      reason: denial.reason,
      bytesIn: 0,
      bytesOut: 0,
    });
  };

  const refuse = (socket: Socket, host: string, denial: Pick<Denial, "rule" | "reason">) => {
    recordDenial(host, denial);

    socket.end(rawResponse("403 Forbidden", denialBody(host, denial)));
  };

  const recordOnClose = (
    connection: Connection,
    rule: string,
    counters: { bytesIn: number; bytesOut: number },
  ) => {
    connection.client.once("close", () => {
      record({ host: connection.host, sni: connection.sni, decision: "allow", rule, ...counters });
    });
  };

  const gatewayCertificate =
    options.gateway === undefined || options.ca === undefined
      ? undefined
      : await options.ca.leaf(options.gateway.host);

  if (options.gateway !== undefined && gatewayCertificate === undefined) {
    throw new LauncherError("the proxy needs the launcher CA to serve the gateway host");
  }

  const gatewayServer =
    options.gateway === undefined
      ? undefined
      : createGatewayForwarder({ route: options.gateway, dial, upstreamCa: options.upstreamCa });

  const secureContext =
    gatewayCertificate === undefined ? undefined : createSecureContext(gatewayCertificate);

  const interceptGateway = (connection: Connection, head: Buffer) => {
    const { client, host } = connection;

    if (head.length > 0 || gatewayServer === undefined || secureContext === undefined) {
      refuse(client, host, { rule: "sni", reason: "client sent data before the tunnel was established" });

      return;
    }

    client.write(ESTABLISHED);

    const secure = new TLSSocket(client, {
      isServer: true,
      secureContext,
      ALPNProtocols: ["http/1.1"],
      SNICallback: (servername, callback) => {
        connection.sni = servername;

        if (normalizeHost(servername) !== normalizeHost(host)) {
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

      gatewayServer.emit("connection", secure);
    });

    client.once("close", () => {
      if (state.secured) {
        record({
          host,
          sni: connection.sni,
          decision: "allow",
          rule: "gateway",
          bytesIn: client.bytesWritten,
          bytesOut: client.bytesRead,
        });

        return;
      }

      recordDenial(host, gatewayHandshakeDenial(host, connection.sni), connection.sni);
    });
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

    recordOnClose(connection, "egress.allow", counters);

    upstream.write(hello);

    client.pipe(upstream).pipe(client);

    client.on("close", () => upstream.destroy());

    upstream.on("close", () => client.destroy());

    client.resume();
  };

  const checkHello = async (connection: Connection, port: number, upstream: Socket, head: Buffer) => {
    const hello = await readClientHello(connection.client, head, helloTimeoutMs);
    const sni = parseServerName(hello);

    connection.sni = sni;

    const decision =
      sni === undefined
        ? ({ allowed: false, rule: "sni", reason: "no TLS ClientHello with a server name" } as const)
        : decideConnect({ host: connection.host, port, sni }, options.policy);

    if (!decision.allowed) {
      recordDenial(connection.host, decision, sni);

      upstream.destroy();

      connection.client.destroy();

      return;
    }

    splice(connection, upstream, hello);
  };

  const tunnel = (connection: Connection, port: number, head: Buffer) => {
    const upstream = dial(connection.host, port, "tunnel");
    const { client, host } = connection;

    sockets.add(upstream);

    upstream.once("close", () => sockets.delete(upstream));

    const onDialError = (error: Error) => {
      if (error instanceof RestrictedAddressError) {
        refuse(client, host, { rule: error.rule, reason: error.message });

        return;
      }

      recordDenial(host, { rule: "upstream", reason: error.message });

      client.end(rawResponse("502 Bad Gateway", { error: `cannot reach ${host}: ${error.message}` }));
    };

    upstream.once("error", onDialError);

    upstream.once("connect", () => {
      upstream.off("error", onDialError);

      upstream.on("error", () => client.destroy());

      client.write(ESTABLISHED);

      void checkHello(connection, port, upstream, head);
    });

    client.once("close", () => upstream.destroy());
  };

  const handleConnect = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const client = socket as Socket;
    const target = parseAuthority(request.url);

    sockets.add(client);

    client.once("close", () => sockets.delete(client));

    client.on("error", () => client.destroy());

    if (!isAuthorized(request, expectedAuthorization)) {
      recordDenial(target?.host ?? UNPARSEABLE, AUTH_DENIAL);

      client.end(
        rawResponse("407 Proxy Authentication Required", { error: AUTH_DENIAL.reason }, [
          `Proxy-Authenticate: ${AUTH_CHALLENGE}`,
        ]),
      );

      return;
    }

    if (target === undefined) {
      refuse(client, UNPARSEABLE, { rule: "connect", reason: "CONNECT needs host:port" });

      return;
    }

    const host = normalizeHost(target.host);
    const decision = decideConnect({ host, port: target.port }, options.policy);

    if (!decision.allowed) {
      refuse(client, host, decision);

      return;
    }

    const connection: Connection = { host, client };

    if (isGatewayHost(host, target.port, options.policy)) {
      interceptGateway(connection, head);

      return;
    }

    tunnel(connection, target.port, head);
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

  const handlePlain = (request: IncomingMessage, response: ServerResponse) => {
    if (!isAuthorized(request, expectedAuthorization)) {
      recordDenial(hostOf(request.headers.host), AUTH_DENIAL);

      sendJson(response, 407, { error: AUTH_DENIAL.reason }, { "proxy-authenticate": AUTH_CHALLENGE });

      return;
    }

    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, { ok: true, policyHash, pid: process.pid });

      return;
    }

    if (request.method === "GET" && request.url === "/policy") {
      sendJson(response, 200, { ...options.policy, policyHash });

      return;
    }

    const host = hostOf(request.headers.host);
    const denial = { rule: "plain-http", reason: "only HTTPS through CONNECT is proxied" };

    recordDenial(host, denial);

    sendJson(response, 403, denialBody(host, denial));
  };

  const server = createServer(handlePlain);

  server.on("connect", handleConnect);

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
