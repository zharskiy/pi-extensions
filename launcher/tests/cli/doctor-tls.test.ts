import { execFile, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import type { FakeCall } from "../support/fake-runner.ts";
import { createFakeBackend, createHarness, doctorCheck, isTlsProbeScript, unreachable } from "./harness.ts";

interface Issued {
  key: string;
  cert: string;
}

interface Chain {
  root: string;
  intermediate: Issued;
  leaf: Issued;
  stranger: string;
}

interface ParentProxy {
  url: string;
  connects: Array<{ target: string; authorization?: string }>;
}

const openssl = promisify(execFile);

const state = { dir: "", chain: undefined as Chain | undefined, tlsPort: 0 };

const closers: Array<() => Promise<void>> = [];

const caExtensions = "basicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\n";

const leafExtensions =
  "basicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = serverAuth\nsubjectAltName = DNS:pi.dev\n";

const pathOf = (name: string) => join(state.dir, name);

const writeKey = async (name: string) => {
  await openssl("openssl", [
    "ecparam",
    "-name",
    "prime256v1",
    "-genkey",
    "-noout",
    "-out",
    pathOf(`${name}.key`),
  ]);

  return readFile(pathOf(`${name}.key`), "utf8");
};

const selfSigned = async (name: string, subject: string) => {
  await writeKey(name);

  await writeFile(pathOf(`${name}.ext`), caExtensions);

  await openssl("openssl", [
    "req",
    "-new",
    "-key",
    pathOf(`${name}.key`),
    "-subj",
    subject,
    "-out",
    pathOf(`${name}.csr`),
  ]);

  await openssl("openssl", [
    "x509",
    "-req",
    "-in",
    pathOf(`${name}.csr`),
    "-signkey",
    pathOf(`${name}.key`),
    "-days",
    "2",
    "-sha256",
    "-extfile",
    pathOf(`${name}.ext`),
    "-out",
    pathOf(`${name}.pem`),
  ]);

  return readFile(pathOf(`${name}.pem`), "utf8");
};

const signed = async (name: string, subject: string, issuer: string, extensions: string): Promise<Issued> => {
  const key = await writeKey(name);

  await writeFile(pathOf(`${name}.ext`), extensions);

  await openssl("openssl", [
    "req",
    "-new",
    "-key",
    pathOf(`${name}.key`),
    "-subj",
    subject,
    "-out",
    pathOf(`${name}.csr`),
  ]);

  await openssl("openssl", [
    "x509",
    "-req",
    "-in",
    pathOf(`${name}.csr`),
    "-CA",
    pathOf(`${issuer}.pem`),
    "-CAkey",
    pathOf(`${issuer}.key`),
    "-set_serial",
    String(Date.now()),
    "-days",
    "2",
    "-sha256",
    "-extfile",
    pathOf(`${name}.ext`),
    "-out",
    pathOf(`${name}.pem`),
  ]);

  return { key, cert: await readFile(pathOf(`${name}.pem`), "utf8") };
};

const chainOf = () => {
  if (state.chain === undefined) {
    throw new Error("the test chain is not ready");
  }

  return state.chain;
};

const listen = async (server: Server | TlsServer) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return (server.address() as AddressInfo).port;
};

beforeAll(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "pi-sandbox-doctor-tls-"));

  const root = await selfSigned("root", "/O=Inspecting Proxy Inc./CN=Inspecting Proxy Root CA");
  const intermediate = await signed(
    "intermediate",
    "/CN=Inspecting Proxy Intermediate CA",
    "root",
    caExtensions,
  );
  const leaf = await signed("leaf", "/CN=pi.dev", "intermediate", leafExtensions);
  const stranger = await selfSigned("stranger", "/CN=Unrelated Corp Root");

  state.chain = { root, intermediate, leaf, stranger };

  const server = createTlsServer({ key: leaf.key, cert: `${leaf.cert}${intermediate.cert}` }, (socket) => {
    socket.end();
  });

  server.on("tlsClientError", () => undefined);

  state.tlsPort = await listen(server);

  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
}, 60_000);

afterAll(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));

  await rm(state.dir, { recursive: true, force: true });
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const parentProxy = async (answer: "tunnel" | "502" = "tunnel"): Promise<ParentProxy> => {
  const connects: ParentProxy["connects"] = [];
  const sockets = new Set<Socket>();
  const server = createServer();

  server.on("connect", (request: IncomingMessage, client: Socket) => {
    sockets.add(client);

    connects.push({ target: request.url ?? "", authorization: request.headers["proxy-authorization"] });

    if (answer === "502") {
      client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");

      return;
    }

    const upstream = connect({ host: "127.0.0.1", port: state.tlsPort }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      upstream.pipe(client).pipe(upstream);
    });

    upstream.on("error", () => client.destroy());

    client.on("error", () => upstream.destroy());
  });

  const port = await listen(server);

  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        sockets.forEach((socket) => {
          socket.destroy();
        });

        server.close(() => resolve());
      }),
  );

  return { url: `http://corp:p%40ss@127.0.0.1:${port}`, connects };
};

const runForReal = (call: FakeCall) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(call.file, call.args, { stdio: ["pipe", "pipe", "pipe"] });
    const output = { stdout: "", stderr: "" };

    child.stdout.on("data", (chunk: Buffer) => {
      output.stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      output.stderr += chunk.toString();
    });

    child.on("close", (code) => resolve({ code: code ?? 1, ...output }));

    child.stdin.end(call.options.input ?? "");
  });

const KEYCHAINS = (home: string) => [
  "/Library/Keychains/System.keychain",
  join(home, "Library", "Keychains", "login.keychain-db"),
];

interface InspectedOptions {
  keychain?: { system?: string; login?: string };
  extras?: boolean;
  answer?: "tunnel" | "502";
}

const doctorThroughInspection = async (options: InspectedOptions = {}) => {
  const proxy = await parentProxy(options.answer);
  const asked: FakeCall[] = [];
  const harness = await createHarness({
    backend: () => unreachable(createFakeBackend().backend),
    env: { HTTPS_PROXY: proxy.url },
    respond: (call) => {
      if (isTlsProbeScript(call)) {
        asked.push(call);

        return runForReal(call);
      }

      if (call.file === "security") {
        asked.push(call);

        const [system, login] = KEYCHAINS(harness.deps.home);
        const keychain = call.args.at(-1);
        const text =
          keychain === system ? options.keychain?.system : keychain === login ? options.keychain?.login : "";

        return { stdout: text ?? "" };
      }

      return undefined;
    },
  });

  if (options.extras === true) {
    await writeFile(join(harness.stateDir, "ca", "extra.pem"), chainOf().root);
  }

  const code = await run(["sandbox", "doctor"], harness.deps);

  return { code, harness, proxy, asked, found: doctorCheck(harness.stdout(), "tls inspection") };
};

const fingerprintOf = (pem: string) => new X509Certificate(pem).fingerprint256;

const doctorWithProbe = async (chain: string[], verdict: string, system = "") => {
  const harness = await createHarness({
    backend: () => unreachable(createFakeBackend().backend),
    respond: (call) => {
      if (isTlsProbeScript(call)) {
        return { stdout: `${JSON.stringify({ chain, verdicts: [verdict], extraCaEnv: null })}\n` };
      }

      return call.file === "security"
        ? { stdout: call.args.at(-1) === KEYCHAINS("")[0] ? system : "" }
        : undefined;
    },
  });

  await run(["sandbox", "doctor"], harness.deps);

  return {
    harness,
    found: doctorCheck(harness.stdout(), "tls inspection"),
    security: harness.calls.filter((call) => call.file === "security"),
  };
};

describe("pi sandbox doctor tls inspection", () => {
  it("passes when pi.dev's chain verifies against Node's built-in roots, asking the probe directly without a parent proxy", async () => {
    const asked: FakeCall[] = [];
    const harness = await createHarness({
      backend: () => unreachable(createFakeBackend().backend),
      respond: (call) => {
        if (isTlsProbeScript(call)) {
          asked.push(call);
        }

        return undefined;
      },
    });

    await run(["sandbox", "doctor"], harness.deps);

    expect(doctorCheck(harness.stdout(), "tls inspection")).toMatchObject({
      section: "network",
      status: "ok",
      detail: "not inspected",
    });
    expect(JSON.parse(asked[0]?.options.input ?? "")).toEqual({
      host: "pi.dev",
      port: 443,
      trusts: ["builtin"],
    });
    expect(harness.calls.filter((call) => call.file === "security")).toEqual([]);
  });

  it("passes an inspected chain that verifies with the tls.extraCa certificates, through the parent proxy with its credentials on stdin", async () => {
    const { found, proxy, asked } = await doctorThroughInspection({ extras: true });

    expect(found).toMatchObject({
      status: "ok",
      detail: "inspected by Inspecting Proxy Root CA, trusted via tls.extraCa",
    });
    expect(proxy.connects).toEqual([
      { target: "pi.dev:443", authorization: `Basic ${Buffer.from("corp:p@ss").toString("base64")}` },
      { target: "pi.dev:443", authorization: `Basic ${Buffer.from("corp:p@ss").toString("base64")}` },
    ]);
    expect(JSON.stringify(asked.map((call) => call.args))).not.toContain("corp");
  });

  it("fails an untrusted inspected chain with the fingerprint of the root found in a keychain and the config to edit", async () => {
    const { code, found, harness, asked } = await doctorThroughInspection({
      keychain: { system: `${chainOf().stranger}${chainOf().root}` },
    });
    const fingerprint = fingerprintOf(chainOf().root);

    expect(found).toMatchObject({
      status: "fail",
      detail: `TLS to pi.dev is signed by "Inspecting Proxy Root CA" (sha256 ${fingerprint}), which the sandbox does not trust`,
      reasons: [],
      hint: `add { "sha256": "${fingerprint}" } to tls.extraCa in ${harness.userConfigFile}\nif it is not in a macOS keychain, export it to PEM and add { "file": "<path to the PEM>" } instead`,
    });
    expect(asked.filter((call) => call.file === "security").map((call) => call.args)).toEqual(
      KEYCHAINS(harness.deps.home).map((keychain) => ["find-certificate", "-a", "-p", keychain]),
    );
    expect(code).toBe(1);
  });

  it("finds the root in the login keychain too", async () => {
    const { found } = await doctorThroughInspection({
      keychain: { login: chainOf().root },
    });

    expect(found?.detail).toContain(`(sha256 ${fingerprintOf(chainOf().root)})`);
  });

  it("names the issuer to ask IT for when no keychain certificate is the root above the chain", async () => {
    const { found, harness } = await doctorThroughInspection({
      keychain: { system: chainOf().stranger },
    });

    expect(found).toMatchObject({
      status: "fail",
      detail: 'TLS to pi.dev is signed by "Inspecting Proxy Root CA", which the sandbox does not trust',
      reasons: [
        "no certificate in the macOS System or login keychain is the root CA above it (issuer O=Inspecting Proxy Inc., CN=Inspecting Proxy Root CA)",
      ],
      hint: `ask your IT for the root CA certificate of "Inspecting Proxy Root CA" as PEM and add { "file": "<path to the PEM>" } to tls.extraCa in ${harness.userConfigFile}`,
    });
    expect(found?.detail).not.toContain("sha256");
  });

  it("asks IT for the PEM when the chain carries its own root but no keychain holds it", async () => {
    const { leaf, intermediate, root, stranger } = chainOf();
    const { found, harness } = await doctorWithProbe(
      [leaf.cert, intermediate.cert, root],
      "SELF_SIGNED_CERT_IN_CHAIN",
      stranger,
    );

    expect(found).toMatchObject({
      status: "fail",
      detail: 'TLS to pi.dev is signed by "Inspecting Proxy Root CA", which the sandbox does not trust',
      hint: `ask your IT for the root CA certificate of "Inspecting Proxy Root CA" as PEM and add { "file": "<path to the PEM>" } to tls.extraCa in ${harness.userConfigFile}`,
    });
    expect(JSON.stringify(found)).not.toContain("sha256");
  });

  it("recommends the sha256 of a root the chain carries when a keychain holds it too", async () => {
    const { leaf, intermediate, root } = chainOf();
    const { found } = await doctorWithProbe(
      [leaf.cert, intermediate.cert, root],
      "SELF_SIGNED_CERT_IN_CHAIN",
      root,
    );

    expect(found?.hint).toContain(`add { "sha256": "${fingerprintOf(root)}" }`);
  });

  it.each(["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"])(
    "reports %s as the verdict, not as inspection",
    async (verdict) => {
      const { leaf, intermediate } = chainOf();
      const { found, security } = await doctorWithProbe([leaf.cert, intermediate.cert], verdict);

      expect(found).toMatchObject({
        status: "fail",
        detail: `TLS to pi.dev does not verify: ${verdict}`,
        reasons: ["the error is not about an unknown issuer, so it is not TLS inspection"],
      });
      expect(security).toEqual([]);
    },
  );

  it("reports a network failure as an unreachable host, not as inspection", async () => {
    const { found, asked } = await doctorThroughInspection({ answer: "502" });

    expect(found).toMatchObject({ status: "fail", detail: "pi.dev:443: the proxy answered 502" });
    expect(asked.filter((call) => call.file === "security")).toEqual([]);
  });
});
