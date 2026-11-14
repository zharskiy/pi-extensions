import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execCapture } from "../../backend/index.ts";
import { bypassesParent, parentRouteFor } from "../../proxy/index.ts";
import { errorMessage, stateLayout } from "../../shared/index.ts";
import type { LaunchContext } from "../context.ts";
import { type CliDeps, pathsOf } from "../deps.ts";
import { type CheckResult, failed, passed } from "./doctor-checks.ts";
import type { ProbeTarget } from "./doctor-probes.ts";

interface Presented {
  chain: string[];
  verdicts: Array<string | null>;
  extraCaEnv?: string | null;
}

type TlsReading = { failure: string } | Presented;

export interface HostTls {
  reading: TlsReading;
  keychain: string[];
  configFile: string;
}

type Trust = "default" | "builtin" | { extraFile: string };

interface ProbeRequest {
  host: string;
  port: number;
  proxy?: { host: string; port: number; authorization?: string } | "env";
  trusts: Trust[];
}

const TLS_PROBE_HOST = "pi.dev";

const TLS_PROBE_PORT = 443;

const AUTHORITY = `${TLS_PROBE_HOST}:${TLS_PROBE_PORT}`;

const HANDSHAKE_TIMEOUT_MS = 10_000;

const PROBE_TIMEOUT_MS = 30_000;

const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";

const LOGIN_KEYCHAIN = join("Library", "Keychains", "login.keychain-db");

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

const MAX_ISSUER_HOPS = 8;

const ISSUER_ERRORS = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const TLS_PROBE_SCRIPT = [
  "const fs = require('node:fs');",
  "const net = require('node:net');",
  "const tls = require('node:tls');",
  "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
  `const timeoutMs = ${HANDSHAKE_TIMEOUT_MS};`,
  "const authority = input.host + ':' + input.port;",
  "const envProxy = () => {",
  "  const text = process.env.HTTPS_PROXY || process.env.https_proxy;",
  "  if (!text) return undefined;",
  "  const url = new URL(text);",
  "  const user = decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password);",
  "  const authorization = url.username || url.password ? 'Basic ' + Buffer.from(user).toString('base64') : undefined;",
  "  return { host: url.hostname.replace(/^\\[|\\]$/g, ''), port: Number(url.port || 80), authorization };",
  "};",
  "const proxy = input.proxy === 'env' ? envProxy() : input.proxy;",
  "const tunnel = () => new Promise((resolve, reject) => {",
  "  const socket = net.connect({ host: proxy.host, port: proxy.port });",
  "  const state = { head: '' };",
  "  const auth = proxy.authorization ? 'Proxy-Authorization: ' + proxy.authorization + '\\r\\n' : '';",
  "  const onData = (chunk) => {",
  "    state.head += chunk.toString('latin1');",
  "    if (!state.head.includes('\\r\\n\\r\\n')) return;",
  "    socket.off('data', onData);",
  "    socket.setTimeout(0);",
  "    const status = state.head.split(' ')[1];",
  "    if (status === '200') return resolve(socket);",
  "    socket.destroy();",
  "    reject(new Error('the proxy answered ' + status));",
  "  };",
  "  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('the proxy did not answer within ' + timeoutMs / 1000 + ' s')));",
  "  socket.once('error', reject);",
  "  socket.on('data', onData);",
  "  socket.once('connect', () => socket.write('CONNECT ' + authority + ' HTTP/1.1\\r\\nHost: ' + authority + '\\r\\n' + auth + '\\r\\n'));",
  "});",
  "const pemOf = (raw) => '-----BEGIN CERTIFICATE-----\\n' + raw.toString('base64').match(/.{1,64}/g).join('\\n') + '\\n-----END CERTIFICATE-----\\n';",
  "const chainOf = (cert, seen) => {",
  "  if (!cert || !cert.raw || seen.some((entry) => entry.fingerprint256 === cert.fingerprint256)) return seen;",
  "  return chainOf(cert.issuerCertificate, [...seen, cert]);",
  "};",
  "const caOf = (trust) => {",
  "  if (trust === 'default') return {};",
  "  const extra = trust === 'builtin' ? [] : [fs.readFileSync(trust.extraFile, 'utf8')];",
  "  return { ca: [...tls.rootCertificates, ...extra] };",
  "};",
  "const handshake = async (trust) => {",
  "  const socket = proxy ? await tunnel() : undefined;",
  "  return new Promise((resolve, reject) => {",
  "    const target = socket ? { socket } : { host: input.host, port: input.port };",
  "    const secure = tls.connect({ ...target, servername: input.host, rejectUnauthorized: false, ...caOf(trust) });",
  "    secure.setTimeout(timeoutMs, () => secure.destroy(new Error('no TLS handshake within ' + timeoutMs / 1000 + ' s')));",
  "    secure.once('error', reject);",
  "    secure.once('secureConnect', () => {",
  "      const chain = chainOf(secure.getPeerCertificate(true), []).map((cert) => pemOf(cert.raw));",
  "      const verdict = secure.authorized ? null : String(secure.authorizationError);",
  "      secure.destroy();",
  "      resolve({ chain, verdict });",
  "    });",
  "  });",
  "};",
  "Promise.all(input.trusts.map(handshake)).then(",
  "  (results) => console.log(JSON.stringify({ chain: results[0].chain, verdicts: results.map((result) => result.verdict), extraCaEnv: process.env.NODE_EXTRA_CA_CERTS ?? null })),",
  "  (error) => console.log(JSON.stringify({ failure: String(error?.code ?? error?.message ?? error) })),",
  ");",
].join("\n");

const lastLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);

const parsedLine = (line: string | undefined) => {
  try {
    return JSON.parse(line ?? "") as (Partial<Presented> & { failure?: unknown }) | null;
  } catch {
    return undefined;
  }
};

const readingOf = (stdout: string, stderr: string): TlsReading => {
  const parsed = parsedLine(lastLine(stdout));

  if (typeof parsed?.failure === "string") {
    return { failure: parsed.failure };
  }

  if (Array.isArray(parsed?.chain) && Array.isArray(parsed?.verdicts)) {
    return { chain: parsed.chain, verdicts: parsed.verdicts, extraCaEnv: parsed.extraCaEnv ?? null };
  }

  return { failure: `the TLS probe gave no result (${lastLine(stderr) ?? "no output"})` };
};

const certificateOf = (pem: string) => {
  try {
    return new X509Certificate(pem);
  } catch {
    return undefined;
  }
};

const certificatesIn = (text: string) =>
  (text.match(PEM_BLOCK) ?? []).flatMap((pem) => certificateOf(pem) ?? []);

const hasCertificate = async (path: string) =>
  certificatesIn(await readFile(path, "utf8").catch(() => "")).length > 0;

const keychainCertificates = async (deps: CliDeps) => {
  if (deps.platform !== "darwin") {
    return [];
  }

  const keychains = [SYSTEM_KEYCHAIN, join(deps.home, LOGIN_KEYCHAIN)];
  const found = await Promise.all(
    keychains.map((keychain) =>
      deps.runner
        .run("security", ["find-certificate", "-a", "-p", keychain])
        .then((result) => (result.code === 0 ? (result.stdout.match(PEM_BLOCK) ?? []) : []))
        .catch(() => []),
    ),
  );

  return found.flat();
};

const hostRequest = async (deps: CliDeps, context: LaunchContext): Promise<ProbeRequest> => {
  const route = parentRouteFor(deps.env);
  const extraFile = stateLayout(context.stateDir).extraPem;
  const proxy =
    route === undefined || bypassesParent(route.noProxy, TLS_PROBE_HOST)
      ? {}
      : {
          proxy: {
            host: route.host,
            port: route.port,
            ...(route.authorization === undefined ? {} : { authorization: route.authorization }),
          },
        };
  const extras: Trust[] = (await hasCertificate(extraFile)) ? [{ extraFile }] : [];

  return { host: TLS_PROBE_HOST, port: TLS_PROBE_PORT, ...proxy, trusts: ["builtin", ...extras] };
};

const hostReading = async (deps: CliDeps, context: LaunchContext): Promise<TlsReading> => {
  try {
    const request = await hostRequest(deps, context);
    const { stdout, stderr } = await deps.runner.run(process.execPath, ["-e", TLS_PROBE_SCRIPT], {
      input: JSON.stringify(request),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    return readingOf(stdout, stderr);
  } catch (error) {
    return { failure: errorMessage(error) };
  }
};

const isIssuerError = (verdict: string | null | undefined) => ISSUER_ERRORS.has(verdict ?? "");

const isUntrusted = (reading: TlsReading) =>
  !("failure" in reading) && !reading.verdicts.includes(null) && isIssuerError(reading.verdicts[0]);

export const readHostTls = async (deps: CliDeps, context: LaunchContext): Promise<HostTls> => {
  const reading = await hostReading(deps, context);
  const keychain = isUntrusted(reading) ? await keychainCertificates(deps) : [];

  return { reading, keychain, configFile: pathsOf(deps).userConfigFile };
};

export const readSandboxTls = async (target: ProbeTarget): Promise<TlsReading> => {
  const request: ProbeRequest = {
    host: TLS_PROBE_HOST,
    port: TLS_PROBE_PORT,
    proxy: "env",
    trusts: ["default"],
  };
  const { stdout, stderr } = await execCapture(
    target.backend,
    {
      containerId: target.containerId,
      command: ["node", "-e", TLS_PROBE_SCRIPT],
      env: {},
      workdir: target.workdir,
    },
    JSON.stringify(request),
  );

  return readingOf(stdout, stderr);
};

const commonName = (name: string) =>
  name
    .split("\n")
    .find((part) => part.startsWith("CN="))
    ?.slice("CN=".length) ?? name.replaceAll("\n", ", ");

const isSelfSigned = (cert: X509Certificate) => cert.checkIssued(cert) && cert.verify(cert.publicKey);

const issuerAmong = (cert: X509Certificate, candidates: X509Certificate[]) =>
  candidates.find(
    (candidate) =>
      candidate.fingerprint256 !== cert.fingerprint256 &&
      cert.checkIssued(candidate) &&
      cert.verify(candidate.publicKey),
  );

const rootAbove = (
  cert: X509Certificate,
  candidates: X509Certificate[],
  hops: number,
): X509Certificate | undefined => {
  if (isSelfSigned(cert)) {
    return cert;
  }

  const issuer = issuerAmong(cert, candidates);

  return issuer === undefined || hops === 0 ? undefined : rootAbove(issuer, candidates, hops - 1);
};

const PEM_HINT =
  'if it is not in a macOS keychain, export it to PEM and add { "file": "<path to the PEM>" } instead';

const untrusted = (presented: Presented, host: HostTls) => {
  const certificates = presented.chain.flatMap((pem) => certificateOf(pem) ?? []);
  const top = certificates.at(-1);

  if (top === undefined) {
    return failed(`TLS to ${TLS_PROBE_HOST} presented no certificate: ${presented.verdicts[0]}`);
  }

  const keychain = certificatesIn(host.keychain.join("\n"));
  const root = rootAbove(top, keychain, MAX_ISSUER_HOPS);
  const inKeychain = keychain.some((cert) => cert.fingerprint256 === root?.fingerprint256);

  if (root === undefined || !inKeychain) {
    const issuer = commonName(top.issuer);

    return failed(`TLS to ${TLS_PROBE_HOST} is signed by "${issuer}", which the sandbox does not trust`, {
      reasons: [
        `no certificate in the macOS System or login keychain is the root CA above it (issuer ${top.issuer.replaceAll("\n", ", ")})`,
      ],
      hint: `ask your IT for the root CA certificate of "${issuer}" as PEM and add { "file": "<path to the PEM>" } to tls.extraCa in ${host.configFile}`,
    });
  }

  const fingerprint = root.fingerprint256;

  return failed(
    `TLS to ${TLS_PROBE_HOST} is signed by "${commonName(root.subject)}" (sha256 ${fingerprint}), which the sandbox does not trust`,
    { hint: `add { "sha256": "${fingerprint}" } to tls.extraCa in ${host.configFile}\n${PEM_HINT}` },
  );
};

const topIssuer = (presented: Presented) => {
  const top = certificateOf(presented.chain.at(-1) ?? "");

  return top === undefined ? "an unknown CA" : commonName(top.issuer);
};

export const tlsInspectionResult = (host: HostTls): CheckResult => {
  const { reading } = host;

  if ("failure" in reading) {
    return failed(`${AUTHORITY}: ${reading.failure}`);
  }

  const [builtin, extras] = reading.verdicts;

  if (builtin === null) {
    return passed("not inspected");
  }

  if (extras === null) {
    return passed(`inspected by ${topIssuer(reading)}, trusted via tls.extraCa`);
  }

  if (!isIssuerError(builtin)) {
    return failed(`TLS to ${TLS_PROBE_HOST} does not verify: ${builtin}`, {
      reasons: ["the error is not about an unknown issuer, so it is not TLS inspection"],
    });
  }

  return untrusted(reading, host);
};

const layerOf = (sandbox: Presented, host: Presented) => {
  if (sandbox.chain[0] !== host.chain[0]) {
    return "the sandbox proxy presents another certificate for it than the host sees";
  }

  const bundle = sandbox.extraCaEnv ?? "unset";

  return host.verdicts[0] === null
    ? `the container's trust (NODE_EXTRA_CA_CERTS=${bundle}) does not hold the public roots`
    : `the container's trust (NODE_EXTRA_CA_CERTS=${bundle}) does not hold the tls.extraCa certificates`;
};

export const sandboxTlsResult = (sandbox: TlsReading, host: HostTls): CheckResult => {
  if ("failure" in sandbox) {
    return failed(`${AUTHORITY} through the sandbox proxy: ${sandbox.failure}`);
  }

  const [verdict] = sandbox.verdicts;

  if (verdict === null) {
    return passed(`the container trusts TLS to ${TLS_PROBE_HOST} through the sandbox proxy`);
  }

  const { reading } = host;

  if (!("failure" in reading) && reading.verdicts.includes(null)) {
    return failed(`the host trusts TLS to ${TLS_PROBE_HOST}, the container does not: ${verdict}`, {
      reasons: [layerOf(sandbox, reading)],
    });
  }

  return failed(`the container does not trust TLS to ${TLS_PROBE_HOST}: ${verdict}`, {
    reasons: ["the host does not trust it either, see tls inspection"],
  });
};
