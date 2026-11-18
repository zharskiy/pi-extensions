import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createSecureContext, type SecureContext, TLSSocket } from "node:tls";
import { PROXY_AGENT, rawResponse } from "./replies.ts";
import type { LeafCertificate } from "./tls-ca.ts";

export interface DenialPageOptions {
  leaf(host: string): Promise<LeafCertificate>;
  now?: () => number;
}

const MAX_NAMES = 256;

const MINTS_PER_MINUTE = 30;

const MINT_WINDOW_MS = 60_000;

const IDLE_MS = 10_000;

const pageHeaders = (text: string) => ({
  "content-type": "text/plain; charset=utf-8",
  "content-length": String(Buffer.byteLength(text)),
  connection: "close",
  "proxy-agent": PROXY_AGENT,
});

const rawPage = (text: string) =>
  rawResponse(
    "403 Forbidden",
    [
      ["content-type", "text/plain; charset=utf-8"],
      ["proxy-agent", PROXY_AGENT],
    ],
    text,
  );

export const createDenialPages = (options: DenialPageOptions) => {
  const now = options.now ?? Date.now;
  const contexts = new Map<string, Promise<SecureContext | undefined>>();
  const mints = { times: [] as number[] };
  const texts = new WeakMap<object, string>();

  const server = createServer((request, response) => {
    const text = texts.get(request.socket) ?? "";

    response.writeHead(403, pageHeaders(text));

    response.end(text);
  });

  server.on("upgrade", (request, socket: Duplex) => {
    socket.end(rawPage(texts.get(request.socket) ?? ""));
  });

  server.on("clientError", (_error, socket: Duplex) => {
    socket.destroy();
  });

  const remember = (host: string, context: Promise<SecureContext | undefined>) => {
    contexts.delete(host);

    contexts.set(host, context);

    const excess = [...contexts.keys()].slice(0, Math.max(0, contexts.size - MAX_NAMES));

    excess.forEach((name) => {
      contexts.delete(name);
    });
  };

  const mayMint = () => {
    const current = now();

    mints.times = mints.times.filter((time) => current - time < MINT_WINDOW_MS);

    if (mints.times.length >= MINTS_PER_MINUTE) {
      return false;
    }

    mints.times.push(current);

    return true;
  };

  const context = (host: string) => {
    const known = contexts.get(host);

    if (known !== undefined) {
      remember(host, known);

      return known;
    }

    if (!mayMint()) {
      return Promise.resolve(undefined);
    }

    const created = options.leaf(host).then(
      (leaf) => createSecureContext(leaf),
      () => undefined,
    );

    remember(host, created);

    void created.then((value) => {
      if (value === undefined) {
        contexts.delete(host);
      }
    });

    return created;
  };

  const serve = (client: Socket, secureContext: SecureContext, text: string) => {
    const secure = new TLSSocket(client, { isServer: true, secureContext, ALPNProtocols: ["http/1.1"] });

    client.setTimeout(IDLE_MS, () => client.destroy());

    secure.on("error", () => client.destroy());

    secure.once("secure", () => {
      texts.set(secure, text);

      server.emit("connection", secure);
    });
  };

  return { context, serve };
};
