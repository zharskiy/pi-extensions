import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createSecureContext, type SecureContext, TLSSocket } from "node:tls";
import { boundedCache } from "./bounded-cache.ts";
import { type RawHeader, rawResponse, sendReply, withAgent } from "./replies.ts";
import type { LeafCertificate } from "./tls-ca.ts";

export interface DenialPageOptions {
  leaf(host: string): Promise<LeafCertificate>;
  now?: () => number;
}

const MAX_NAMES = 256;

const MINTS_PER_MINUTE = 30;

const MINT_WINDOW_MS = 60_000;

const IDLE_MS = 10_000;

const PAGE_HEADERS: RawHeader[] = [["content-type", "text/plain; charset=utf-8"]];

export const createDenialPages = (options: DenialPageOptions) => {
  const now = options.now ?? Date.now;
  const contexts = boundedCache<string, SecureContext>(MAX_NAMES);
  const mints = { times: [] as number[] };
  const texts = new WeakMap<object, string>();

  const server = createServer((request, response) => {
    const text = texts.get(request.socket) ?? "";

    sendReply(response, 403, [...PAGE_HEADERS, ["connection", "close"]], text);
  });

  server.on("upgrade", (request, socket: Duplex) => {
    socket.end(rawResponse("403 Forbidden", withAgent(PAGE_HEADERS), texts.get(request.socket) ?? ""));
  });

  server.on("clientError", (_error, socket: Duplex) => {
    socket.destroy();
  });

  const mayMint = () => {
    const current = now();

    mints.times = mints.times.filter((time) => current - time < MINT_WINDOW_MS);

    if (mints.times.length >= MINTS_PER_MINUTE) {
      return false;
    }

    mints.times.push(current);

    return true;
  };

  const cachedContext = (host: string) => {
    const known = contexts.get(host);

    if (known !== undefined) {
      return known;
    }

    if (!mayMint()) {
      return Promise.resolve(undefined);
    }

    return contexts.set(
      host,
      options.leaf(host).then((leaf) => createSecureContext(leaf)),
    );
  };

  const context = (host: string) => cachedContext(host).catch(() => undefined);

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
