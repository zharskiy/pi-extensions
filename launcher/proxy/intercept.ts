import { createSecureContext, type SecureContext, TLSSocket } from "node:tls";
import { normalizeHost } from "../config/index.ts";
import { LauncherError } from "../shared/index.ts";
import type { Denials, RecordAccess } from "./denials.ts";
import type { DialAccess } from "./dial.ts";
import { sniDenial } from "./policy.ts";
import { ESTABLISHED } from "./replies.ts";
import type { TerminatedTarget } from "./terminate.ts";
import type { LeafCertificate } from "./tls-ca.ts";
import type { Connection } from "./tunnel.ts";

interface LeafSource {
  leaf(host: string): Promise<LeafCertificate>;
}

interface InterceptOptions {
  ca?: LeafSource;
  leafRecheckMs: number;
  helloTimeoutMs: number;
  accessOf: (host: string) => DialAccess;
  serve: (socket: TLSSocket, target: TerminatedTarget) => void;
  record: RecordAccess;
  denials: Denials;
}

interface CachedContext {
  cert: string;
  context: SecureContext;
  checkedAt: number;
}

const TLS_FAILED = { rule: "tls", reason: "TLS handshake with the client failed" };

const handshakeDenial = (connection: Connection) => sniDenial(connection.host, connection.sni) ?? TLS_FAILED;

export const createInterceptor = (options: InterceptOptions) => {
  const settled = new Map<string, CachedContext>();
  const refreshing = new Map<string, Promise<CachedContext>>();
  const { denials } = options;

  const loadContext = async (ca: LeafSource, host: string, known: CachedContext | undefined) => {
    const leaf = await ca.leaf(host);
    const context = known?.cert === leaf.cert ? known.context : createSecureContext(leaf);

    return { cert: leaf.cert, context, checkedAt: Date.now() };
  };

  const refresh = (ca: LeafSource, host: string, known: CachedContext | undefined) => {
    const loading = loadContext(ca, host, known)
      .then(
        (loaded) => {
          settled.set(host, loaded);

          return loaded;
        },
        (error: unknown) => {
          settled.delete(host);

          throw error;
        },
      )
      .finally(() => refreshing.delete(host));

    refreshing.set(host, loading);

    return loading;
  };

  const secureContextFor = async (host: string) => {
    if (options.ca === undefined) {
      throw new LauncherError("the proxy needs the launcher CA to terminate TLS");
    }

    const known = settled.get(host);

    if (known !== undefined && Date.now() - known.checkedAt < options.leafRecheckMs) {
      return known.context;
    }

    const loading = refreshing.get(host) ?? refresh(options.ca, host, known);

    return (await loading).context;
  };

  const startTls = (connection: Connection, secureContext: SecureContext) => {
    const { client, host, port } = connection;
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
    const handshake = setTimeout(() => client.destroy(), options.helloTimeoutMs);

    secure.on("error", () => client.destroy());

    secure.once("secure", () => {
      clearTimeout(handshake);

      connection.sni = secure.servername || undefined;

      if (connection.sni === undefined) {
        secure.destroy();

        return;
      }

      state.secured = true;

      options.serve(secure, {
        host,
        port,
        repoHash: connection.repoHash,
        access: options.accessOf(host),
      });
    });

    client.once("close", () => {
      clearTimeout(handshake);

      if (state.secured) {
        options.record({
          repo: connection.repoHash,
          host,
          sni: connection.sni,
          decision: "allow",
          rule: "terminate",
          bytesIn: client.bytesWritten,
          bytesOut: client.bytesRead,
        });

        return;
      }

      denials.note(host, handshakeDenial(connection), {
        port,
        repoHash: connection.repoHash,
        sni: connection.sni,
      });
    });
  };

  return async (connection: Connection, head: Buffer) => {
    const { client, host, port, repoHash } = connection;

    if (head.length > 0) {
      denials.refuse(
        client,
        host,
        { rule: "sni", reason: "client sent data before the tunnel was established" },
        { port, repoHash },
      );

      return;
    }

    const secureContext = await secureContextFor(host).catch(() => undefined);

    if (secureContext === undefined) {
      denials.refuse(
        client,
        host,
        { rule: "tls", reason: `no certificate can be issued for ${host}` },
        { port, repoHash },
      );

      return;
    }

    startTls(connection, secureContext);
  };
};
