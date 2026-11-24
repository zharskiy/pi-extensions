import { readFile } from "node:fs/promises";
import { GUEST_PROXY_HOST, GUEST_PROXY_PORT } from "../backend/index.ts";
import { GUEST_PATHS, nonProxyHosts, pemCertificates, sha256Hex, shortHash } from "../shared/index.ts";

interface CaSources {
  proxyCaPem?: string;
  extraPem?: string;
}

export const TRUST_SCRIPT = "trust-jdk.sh";

export const JDK_NET_PROPERTIES = "jdk-net.properties";

const LIB_DIR = "/usr/local/lib/pinata";

export const TRUST_IMAGE_PATHS = {
  caDir: GUEST_PATHS.sandboxCaDir,
  libDir: LIB_DIR,
  script: `${LIB_DIR}/${TRUST_SCRIPT}`,
};

const certificatesIn = async (path: string | undefined) => {
  const text = path === undefined ? "" : await readFile(path, "utf8");

  return pemCertificates(text);
};

const namedCertificates = (kind: string, certificates: string[]) =>
  certificates.map((pem) => [`${kind}-${shortHash(sha256Hex(pem))}.crt`, `${pem}\n`] as const);

export const caFiles = async (sources: CaSources): Promise<Record<string, string>> => {
  const proxy = namedCertificates("proxy", await certificatesIn(sources.proxyCaPem));
  const extra = namedCertificates("extra", await certificatesIn(sources.extraPem));

  return Object.fromEntries([...proxy, ...extra]);
};

export const jdkNetProperties = () => {
  const lines = ["http", "https"].flatMap((scheme) => [
    `${scheme}.proxyHost=${GUEST_PROXY_HOST}`,
    `${scheme}.proxyPort=${GUEST_PROXY_PORT}`,
  ]);

  return `${[...lines, `http.nonProxyHosts=${nonProxyHosts(GUEST_PROXY_HOST)}`].join("\n")}\n`;
};
