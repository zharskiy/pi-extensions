import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
} from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isHostName } from "../config/index.ts";
import {
  type CommandRunner,
  LauncherError,
  type RunOptions,
  stateLayout,
  withFileLock,
} from "../shared/index.ts";

export interface LeafCertificate {
  key: string;
  cert: string;
}

export interface LauncherCa {
  certPath: string;
  certPem: string;
  leaf(host: string): Promise<LeafCertificate>;
  ephemeralLeaf(host: string): Promise<LeafCertificate>;
}

interface CaOptions {
  stateDir: string;
  runner: CommandRunner;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const CA_VALIDITY_MS = 3650 * DAY_MS;

const LEAF_VALIDITY_MS = 397 * DAY_MS;

const BACKDATE_MS = 60 * 60 * 1000;

const GENERALIZED_TIME_YEAR = 2050;

const RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;

const PRIVATE_MODE = 0o600;

const MINT_LOCK_TIMEOUT_MS = 30_000;

const MAX_LEAVES = 256;

const CA_KEY = "ca-key.pem";

const CA_CERT = "ca-cert.pem";

const issueSections = `[ca]
default_ca = issue
[issue]
database = index.txt
new_certs_dir = .
serial = serial
default_md = sha256
policy = policy
unique_subject = no
[policy]
commonName = supplied
`;

const caConfig = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = pi-sandbox launcher CA
[authority]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
${issueSections}`;

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
${issueSections}`;

export const certificateTime = (time: number) => {
  const date = new Date(time);
  const stamp = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);

  return date.getUTCFullYear() < GENERALIZED_TIME_YEAR ? `${stamp.slice(2)}Z` : `${stamp}Z`;
};

const readOptional = async (path: string) => readFile(path, "utf8").catch(() => undefined);

const parseCertificate = (pem: string | undefined) => {
  try {
    return pem === undefined ? undefined : new X509Certificate(pem);
  } catch {
    return undefined;
  }
};

const isFresh = (certificate: X509Certificate | undefined): certificate is X509Certificate =>
  certificate !== undefined && Date.parse(certificate.validTo) - Date.now() > RENEW_MARGIN_MS;

const newPrivateKey = () =>
  String(
    generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }),
  );

const writePrivateKey = async (path: string) => {
  await writeFile(path, newPrivateKey(), { mode: PRIVATE_MODE });

  await chmod(path, PRIVATE_MODE);
};

const publicDer = (key: string | X509Certificate) => {
  const publicKey = typeof key === "string" ? createPublicKey(createPrivateKey(key)) : key.publicKey;

  return publicKey.export({ type: "spki", format: "der" });
};

const keyMatches = (key: string, certificate: X509Certificate) => {
  try {
    return publicDer(key).equals(publicDer(certificate));
  } catch {
    return false;
  }
};

const openssl = async (runner: CommandRunner, args: string[], options?: RunOptions) => {
  const result = await runner.run("openssl", args, options);

  if (result.code !== 0) {
    throw new LauncherError(
      `openssl ${args[0]} failed: ${result.stderr.trim().split("\n").at(-1) ?? ""}`,
      "check that openssl is installed and on PATH",
    );
  }
};

const signRequest = async (
  runner: CommandRunner,
  work: string,
  signer: string[],
  extensions: string,
  validityMs: number,
) => {
  await writeFile(join(work, "index.txt"), "");

  await writeFile(join(work, "serial"), `${randomBytes(16).toString("hex")}\n`);

  await openssl(runner, ["req", "-new", "-key", "key.pem", "-config", "issue.cnf", "-out", "request.csr"], {
    cwd: work,
  });

  const now = Date.now();

  await openssl(
    runner,
    [
      "ca",
      "-batch",
      "-notext",
      "-config",
      "issue.cnf",
      ...signer,
      "-in",
      "request.csr",
      "-out",
      "cert.pem",
      "-startdate",
      certificateTime(now - BACKDATE_MS),
      "-enddate",
      certificateTime(now + validityMs),
      "-extfile",
      "issue.cnf",
      "-extensions",
      extensions,
    ],
    { cwd: work },
  );
};

const generateCa = async (directory: string, runner: CommandRunner) => {
  const work = await mkdtemp(join(directory, "new-"));

  try {
    await writePrivateKey(join(work, "key.pem"));

    await writeFile(join(work, "issue.cnf"), caConfig);

    await signRequest(runner, work, ["-selfsign", "-keyfile", "key.pem"], "authority", CA_VALIDITY_MS);

    await rename(join(work, "key.pem"), join(directory, CA_KEY));

    await rename(join(work, "cert.pem"), join(directory, CA_CERT));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

const storedCa = async (directory: string) => {
  const key = await readOptional(join(directory, CA_KEY));
  const certPem = await readOptional(join(directory, CA_CERT));
  const certificate = parseCertificate(certPem);

  return key !== undefined && certPem !== undefined && isFresh(certificate) && keyMatches(key, certificate)
    ? { certPem, certificate }
    : undefined;
};

const ensureCa = async (directory: string, lockPath: string, runner: CommandRunner) => {
  const current = await storedCa(directory);

  if (current !== undefined) {
    return current;
  }

  return withFileLock(
    lockPath,
    async () => {
      const again = await storedCa(directory);

      if (again !== undefined) {
        return again;
      }

      await generateCa(directory, runner);

      const created = await storedCa(directory);

      if (created === undefined) {
        throw new LauncherError(`the launcher CA in ${directory} could not be created`);
      }

      return created;
    },
    { timeoutMs: MINT_LOCK_TIMEOUT_MS },
  );
};

const signLeaf = async (directory: string, host: string, runner: CommandRunner): Promise<LeafCertificate> => {
  const work = await mkdtemp(join(directory, "work-"));
  const signer = ["-cert", resolve(join(directory, CA_CERT)), "-keyfile", resolve(join(directory, CA_KEY))];

  try {
    await writePrivateKey(join(work, "key.pem"));

    await writeFile(join(work, "issue.cnf"), leafConfig(host));

    await signRequest(runner, work, signer, "leaf", LEAF_VALIDITY_MS);

    return {
      key: await readFile(join(work, "key.pem"), "utf8"),
      cert: await readFile(join(work, "cert.pem"), "utf8"),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

export const openLauncherCa = async ({ stateDir, runner }: CaOptions): Promise<LauncherCa> => {
  const layout = stateLayout(stateDir);
  const directory = layout.ca;
  const certPath = join(directory, CA_CERT);

  await mkdir(directory, { recursive: true, mode: 0o700 });

  const { certPem } = await ensureCa(directory, layout.caLock, runner);
  const leaves = new Map<string, Promise<{ leaf: LeafCertificate; renewAt: number }>>();

  const checkHost = (host: string) => {
    if (!isHostName(host)) {
      throw new LauncherError(`cannot issue a certificate for ${host}`, "use a DNS hostname for the host");
    }
  };

  const mint = (host: string) => {
    const minted = signLeaf(directory, host, runner).then((leaf) => ({
      leaf,
      renewAt: Date.parse(new X509Certificate(leaf.cert).validTo) - RENEW_MARGIN_MS,
    }));

    leaves.set(host, minted);

    minted.catch(() => {
      if (leaves.get(host) === minted) {
        leaves.delete(host);
      }
    });

    const [oldest] = leaves.keys();

    if (leaves.size > MAX_LEAVES && oldest !== undefined) {
      leaves.delete(oldest);
    }

    return minted;
  };

  const leaf = async (host: string): Promise<LeafCertificate> => {
    checkHost(host);

    const cached = leaves.get(host);

    if (cached === undefined) {
      return (await mint(host)).leaf;
    }

    leaves.delete(host);

    leaves.set(host, cached);

    const current = await cached;

    return Date.now() < current.renewAt ? current.leaf : (await mint(host)).leaf;
  };

  const ephemeralLeaf = async (host: string): Promise<LeafCertificate> => {
    checkHost(host);

    return signLeaf(directory, host, runner);
  };

  return { certPath, certPem, leaf, ephemeralLeaf };
};
