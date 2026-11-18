import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export interface TestCertificate {
  key: string;
  cert: string;
}

export interface TestCa {
  certPath: string;
  certPem: string;
  issue(hosts: string[]): Promise<TestCertificate>;
}

const run = promisify(execFile);

const caConfig = (name: string) => `[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${name}
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
`;

const leafConfig = (hosts: string[]) => `[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${hosts[0]}
[leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = ${hosts.map((host) => `DNS:${host}`).join(",")}
authorityKeyIdentifier = keyid
`;

const writeKey = async (path: string) => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  await writeFile(path, pem, { mode: 0o600 });

  return pem;
};

export const createTestCa = async (directory: string, name: string): Promise<TestCa> => {
  const keyPath = join(directory, `${name}-key.pem`);
  const certPath = join(directory, `${name}-cert.pem`);
  const configPath = join(directory, `${name}.cnf`);

  await writeKey(keyPath);

  await writeFile(configPath, caConfig(name));

  await run("openssl", [
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
    "2",
    "-sha256",
    "-out",
    certPath,
  ]);

  const issue = async (hosts: string[]): Promise<TestCertificate> => {
    const base = join(directory, `${name}-leaf-${randomBytes(4).toString("hex")}`);
    const key = await writeKey(`${base}-key.pem`);

    await writeFile(`${base}.cnf`, leafConfig(hosts));

    await run("openssl", [
      "req",
      "-new",
      "-key",
      `${base}-key.pem`,
      "-config",
      `${base}.cnf`,
      "-out",
      `${base}.csr`,
    ]);

    await run("openssl", [
      "x509",
      "-req",
      "-in",
      `${base}.csr`,
      "-CA",
      certPath,
      "-CAkey",
      keyPath,
      "-set_serial",
      `0x${randomBytes(16).toString("hex")}`,
      "-days",
      "2",
      "-sha256",
      "-extfile",
      `${base}.cnf`,
      "-extensions",
      "leaf",
      "-out",
      `${base}-cert.pem`,
    ]);

    return { key, cert: await readFile(`${base}-cert.pem`, "utf8") };
  };

  return { certPath, certPem: await readFile(certPath, "utf8"), issue };
};
