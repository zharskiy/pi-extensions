import { createSecureContext, type SecureContext, TLSSocket } from "node:tls";
import { normalizeHost } from "../config/index.ts";
import type { Denials, RecordAccess } from "./denials.ts";
import { sniDenial } from "./policy.ts";
import { ESTABLISHED } from "./replies.ts";
import type { TerminatedTarget } from "./terminate.ts";
import type { LeafCertificate } from "./tls-ca.ts";
import type { Connection } from "./tunnel.ts";

interface LeafSource {
  leaf(host: string): Promise<LeafCertificate>;
}

interface InterceptOptions {
  ca: LeafSource;
  helloTimeoutMs: number;
  serve: (socket: TLSSocket, target: TerminatedTarget) => void;
  record: RecordAccess;
  denials: Denials;
}

const TLS_FAILED = { rule: "tls", reason: "TLS handshake with the client failed" };

const CLIENT_CLOSED = {
  rule: "tls",
  reason:
    "the client closed the connection during the TLS handshake, so it may not trust the launcher CA or the VM's clock may be more than an hour behind the host's",
};

const CLIENT_REJECTED = {
  rule: "tls",
  reason:
    "the client rejected the proxy's certificate, so it may not trust the launcher CA or the VM's clock may be more than an hour behind the host's",
};

const CLIENT_LEFT = { rule: "tls", reason: "the client closed the connection before its TLS hello" };

const CERTIFICATE_ALERTS = [
  "_ALERT_UNKNOWN_CA",
  "_ALERT_BAD_CERTIFICATE",
  "_ALERT_CERTIFICATE_EXPIRED",
  "_ALERT_CERTIFICATE_UNKNOWN",
];

interface HandshakeEnd {
  ended: boolean;
  silent: boolean;
  timedOut?: boolean;
  errorCode?: string;
}

const isCertificateAlert = (code: string | undefined) =>
  code !== undefined && CERTIFICATE_ALERTS.some((alert) => code.endsWith(alert));

export const handshakeDenial = (connection: Pick<Connection, "host" | "sni">, end: HandshakeEnd) => {
  if (end.silent && end.timedOut !== true) {
    return CLIENT_LEFT;
  }

  const fallback = isCertificateAlert(end.errorCode)
    ? CLIENT_REJECTED
    : end.ended
      ? CLIENT_CLOSED
      : TLS_FAILED;

  return sniDenial(connection.host, connection.sni) ?? fallback;
};

export const createInterceptor = (options: InterceptOptions) => {
  const contexts = new WeakMap<LeafCertificate, SecureContext>();
  const { denials } = options;

  const secureContextFor = async (host: string) => {
    const leaf = await options.ca.leaf(host);
    const known = contexts.get(leaf);

    if (known !== undefined) {
      return known;
    }

    const context = createSecureContext(leaf);

    contexts.set(leaf, context);

    return context;
  };

  const startTls = (connection: Connection, secureContext: SecureContext, helloStart: number) => {
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
    const state: { secured: boolean; ended: boolean; timedOut: boolean; errorCode?: string } = {
      secured: false,
      ended: false,
      timedOut: false,
    };
    const handshake = setTimeout(() => {
      state.timedOut = true;

      client.destroy();
    }, options.helloTimeoutMs);

    secure.on("error", (error: NodeJS.ErrnoException) => {
      state.errorCode ??= error.code;

      client.destroy();
    });

    secure.once("end", () => {
      if (!state.secured) {
        state.ended = true;

        client.destroy();
      }
    });

    secure.once("secure", () => {
      clearTimeout(handshake);

      connection.sni = secure.servername || undefined;

      if (connection.sni === undefined) {
        secure.destroy();

        return;
      }

      state.secured = true;

      options.serve(secure, { host, port, access: connection.access });
    });

    client.once("close", () => {
      clearTimeout(handshake);

      if (state.secured) {
        options.record({
          host,
          sni: connection.sni,
          decision: "allow",
          rule: "terminate",
          bytesIn: client.bytesWritten,
          bytesOut: client.bytesRead,
        });

        return;
      }

      const end = { ...state, silent: client.bytesRead === helloStart };

      denials.note(host, handshakeDenial(connection, end), {
        port,
        sni: connection.sni,
      });
    });
  };

  return async (connection: Connection, head: Buffer) => {
    const { client, host, port } = connection;
    const helloStart = client.bytesRead;

    if (head.length > 0) {
      denials.refuse(
        client,
        host,
        { rule: "sni", reason: "client sent data before the tunnel was established" },
        { port },
      );

      return;
    }

    const secureContext = await secureContextFor(host).catch(() => undefined);

    if (secureContext === undefined) {
      denials.refuse(
        client,
        host,
        { rule: "tls", reason: `no certificate can be issued for ${host}` },
        { port },
      );

      return;
    }

    startTls(connection, secureContext, helloStart);
  };
};
