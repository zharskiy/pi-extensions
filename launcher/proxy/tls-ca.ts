import { generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CommandRunner, createProcessRunner, LauncherError } from "../shared/index.ts";

export interface LeafCertificate {
  key: string;
  cert: string;
}

export interface LauncherCa {
  certPath: string;
  certPem: string;
  leaf(host: string): Promise<LeafCertificate>;
}

interface CaOptions {
  stateDir: string;
  runner: CommandRunner;
}

const CA_DAYS = "3650";

const LEAF_DAYS = "397";

const RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;

const PRIVATE_MODE = 0o600;

const LEAF_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const caConfig = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = pi-sandbox launcher CA
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
`;

const leafConfig = (host: string) => `[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${host}
[leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:${host}
authorityKeyIdentifier = keyid
`;

const readOptional = async (path: string) => readFile(path, "utf8").catch(() => undefined);

const parseCertificate = (pem: string | undefined) => {
  try {
    return pem === undefined ? undefined : new X509Certificate(pem);
  } catch {
    return undefined;
  }
};

const isFresh = (certificate: X509Certificate | undefined) =>
  certificate !== undefined && Date.parse(certificate.validTo) - Date.now() > RENEW_MARGIN_MS;

const writePrivateKey = async (path: string) => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

  await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: PRIVATE_MODE });

  await chmod(path, PRIVATE_MODE);
};

const openssl = async (runner: CommandRunner, args: string[]) => {
  const result = await runner.run("openssl", args);

  if (result.code !== 0) {
    throw new LauncherError(
      `openssl ${args[0]} failed: ${result.stderr.trim().split("\n").at(-1) ?? ""}`,
      "check that openssl is installed and on PATH",
    );
  }
};

const createCa = async (directory: string, runner: CommandRunner) => {
  const keyPath = join(directory, "ca-key.pem");
  const configPath = join(directory, "ca.cnf");

  await writePrivateKey(keyPath);

  await writeFile(configPath, caConfig);

  await openssl(runner, [
    "req",
    "-x509",
    "-new",
    "-key",
    keyPath,
    "-config",
    configPath,
    "-extensions",
    "ca",
    "-days",
    CA_DAYS,
    "-sha256",
    "-out",
    join(directory, "ca-cert.pem"),
  ]);
};

const createLeaf = async (directory: string, host: string, runner: CommandRunner) => {
  const base = join(directory, "leaf", host);
  const configPath = `${base}.cnf`;
  const requestPath = `${base}.csr`;

  await mkdir(join(directory, "leaf"), { recursive: true });

  await writePrivateKey(`${base}-key.pem`);

  await writeFile(configPath, leafConfig(host));

  await openssl(runner, [
    "req",
    "-new",
    "-key",
    `${base}-key.pem`,
    "-config",
    configPath,
    "-out",
    requestPath,
  ]);

  await openssl(runner, [
    "x509",
    "-req",
    "-in",
    requestPath,
    "-CA",
    join(directory, "ca-cert.pem"),
    "-CAkey",
    join(directory, "ca-key.pem"),
    "-set_serial",
    `0x${randomBytes(16).toString("hex")}`,
    "-days",
    LEAF_DAYS,
    "-sha256",
    "-extfile",
    configPath,
    "-extensions",
    "leaf",
    "-out",
    `${base}-cert.pem`,
  ]);

  await rm(requestPath, { force: true });
};

export const openLauncherCa = async ({ stateDir, runner }: CaOptions): Promise<LauncherCa> => {
  const directory = join(stateDir, "ca");
  const certPath = join(directory, "ca-cert.pem");

  await mkdir(directory, { recursive: true, mode: 0o700 });

  const existing = parseCertificate(await readOptional(certPath));

  if (!isFresh(existing)) {
    await createCa(directory, runner);
  }

  const certPem = await readFile(certPath, "utf8");
  const authority = new X509Certificate(certPem);

  const leaf = async (host: string): Promise<LeafCertificate> => {
    if (!LEAF_HOST.test(host)) {
      throw new LauncherError(`cannot issue a certificate for ${host}`, "use a DNS hostname for the gateway");
    }

    const base = join(directory, "leaf", host);
    const current = parseCertificate(await readOptional(`${base}-cert.pem`));

    if (!isFresh(current) || !current?.checkIssued(authority)) {
      await createLeaf(directory, host, runner);
    }

    return {
      key: await readFile(`${base}-key.pem`, "utf8"),
      cert: await readFile(`${base}-cert.pem`, "utf8"),
    };
  };

  return { certPath, certPem, leaf };
};

export const ensureLauncherCa = async (stateDir: string, runner: CommandRunner = createProcessRunner()) => {
  const ca = await openLauncherCa({ stateDir, runner });

  return { certPemPath: ca.certPath };
};
