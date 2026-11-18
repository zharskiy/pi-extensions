import { readFileSync } from "node:fs";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type DetailedPeerCertificate, rootCertificates } from "node:tls";

export type Trust = "default" | "builtin" | { extraFile: string };

interface ProxyTarget {
  host: string;
  port: number;
  authorization?: string;
}

export interface ProbeRequest {
  host: string;
  port: number;
  proxy?: ProxyTarget | "env";
  trusts: Trust[];
  timeoutMs: number;
}

interface Handshake {
  chain: string[];
  verdict: string | null;
}

const input = JSON.parse(readFileSync(0, "utf8")) as ProbeRequest;

const { timeoutMs } = input;

const authority = `${input.host}:${input.port}`;

const envProxy = (): ProxyTarget | undefined => {
  const text = process.env.HTTPS_PROXY || process.env.https_proxy;

  if (!text) {
    return undefined;
  }

  const url = new URL(text);
  const user = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  const authorization =
    url.username || url.password ? `Basic ${Buffer.from(user).toString("base64")}` : undefined;

  return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80), authorization };
};

const proxy = input.proxy === "env" ? envProxy() : input.proxy;

const tunnel = (through: ProxyTarget) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = connectTcp({ host: through.host, port: through.port });
    const state = { head: "" };
    const auth = through.authorization ? `Proxy-Authorization: ${through.authorization}\r\n` : "";
    const onData = (chunk: Buffer) => {
      state.head += chunk.toString("latin1");

      if (!state.head.includes("\r\n\r\n")) {
        return;
      }

      socket.off("data", onData);

      socket.setTimeout(0);

      const status = state.head.split(" ")[1];

      if (status === "200") {
        resolve(socket);

        return;
      }

      socket.destroy();

      reject(new Error(`the proxy answered ${status}`));
    };

    socket.setTimeout(timeoutMs, () =>
      socket.destroy(new Error(`the proxy did not answer within ${timeoutMs / 1000} s`)),
    );

    socket.once("error", reject);

    socket.on("data", onData);

    socket.once("connect", () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`),
    );
  });

const pemOf = (raw: Buffer) =>
  `-----BEGIN CERTIFICATE-----\n${(raw.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END CERTIFICATE-----\n`;

const chainOf = (
  cert: DetailedPeerCertificate | undefined,
  seen: DetailedPeerCertificate[],
): DetailedPeerCertificate[] => {
  if (!cert?.raw || seen.some((entry) => entry.fingerprint256 === cert.fingerprint256)) {
    return seen;
  }

  return chainOf(cert.issuerCertificate, [...seen, cert]);
};

const caOf = (trust: Trust) => {
  if (trust === "default") {
    return {};
  }

  const extra = trust === "builtin" ? [] : [readFileSync(trust.extraFile, "utf8")];

  return { ca: [...rootCertificates, ...extra] };
};

const handshake = async (trust: Trust) => {
  const socket = proxy ? await tunnel(proxy) : undefined;

  return new Promise<Handshake>((resolve, reject) => {
    const target = socket ? { socket } : { host: input.host, port: input.port };
    const secure = connectTls({
      ...target,
      servername: input.host,
      rejectUnauthorized: false,
      ...caOf(trust),
    });

    secure.setTimeout(timeoutMs, () =>
      secure.destroy(new Error(`no TLS handshake within ${timeoutMs / 1000} s`)),
    );

    secure.once("error", reject);

    secure.once("secureConnect", () => {
      const chain = chainOf(secure.getPeerCertificate(true), []).map((cert) => pemOf(cert.raw));
      const verdict = secure.authorized ? null : String(secure.authorizationError);

      secure.destroy();

      resolve({ chain, verdict });
    });
  });
};

const failureOf = (error: unknown) => {
  const fields = (error ?? {}) as { code?: unknown; message?: unknown };

  return String(fields.code ?? fields.message ?? error);
};

Promise.all(input.trusts.map(handshake)).then(
  (results) =>
    console.log(
      JSON.stringify({
        chain: results[0]?.chain,
        verdicts: results.map((result) => result.verdict),
        extraCaEnv: process.env.NODE_EXTRA_CA_CERTS ?? null,
      }),
    ),
  (error: unknown) => console.log(JSON.stringify({ failure: failureOf(error) })),
);
