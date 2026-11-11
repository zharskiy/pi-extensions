import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { ExtraCa } from "../config/index.ts";
import {
  type CommandRunner,
  expandHome,
  LauncherError,
  sha256Hex,
  stateLayout,
  writeFileAtomic,
} from "../shared/index.ts";
import { openLauncherCa } from "./tls-ca.ts";

export interface TrustBundleInput {
  stateDir: string;
  runner: CommandRunner;
  platform: NodeJS.Platform;
  sources: ExtraCa[];
}

export interface TrustBundle {
  pemPath: string;
  caCertPath: string;
  extraPemPath: string;
  hash: string;
}

const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";

const PUBLIC_MODE = 0o644;

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

const isCertificate = (pem: string) => {
  try {
    return new X509Certificate(pem).fingerprint256 !== "";
  } catch {
    return false;
  }
};

const certificatesIn = (text: string) => (text.match(PEM_BLOCK) ?? []).filter(isCertificate);

const fileCertificates = async (file: string) => {
  const path = expandHome(file, homedir());
  const text = await readFile(path, "utf8").catch(() => undefined);

  if (text === undefined) {
    throw new LauncherError(`tls.extraCa: ${path} is not readable`, "fix the path or remove the entry");
  }

  const found = certificatesIn(text);

  if (found.length === 0) {
    throw new LauncherError(`tls.extraCa: ${path} holds no PEM certificate`);
  }

  return found;
};

const hostStoreCertificates = async (runner: CommandRunner, platform: NodeJS.Platform) => {
  if (platform !== "darwin") {
    return [];
  }

  const result = await runner.run("security", ["find-certificate", "-a", "-p", SYSTEM_KEYCHAIN]);

  if (result.code !== 0) {
    throw new LauncherError(
      `tls.extraCa hostStore: security find-certificate exited with ${result.code}`,
      "check the System keychain, or list the CA file with { file } instead",
    );
  }

  return certificatesIn(result.stdout);
};

const sourceCertificates = (input: TrustBundleInput) => (source: ExtraCa) =>
  "file" in source ? fileCertificates(source.file) : hostStoreCertificates(input.runner, input.platform);

const writeIfChanged = async (path: string, text: string) => {
  const current = await readFile(path, "utf8").catch(() => undefined);

  if (current !== text) {
    await writeFileAtomic(path, text, { mode: PUBLIC_MODE });
  }
};

const pemText = (certificates: string[]) => certificates.map((pem) => `${pem.trim()}\n`).join("");

export const ensureTrustBundle = async (input: TrustBundleInput): Promise<TrustBundle> => {
  const ca = await openLauncherCa({ stateDir: input.stateDir, runner: input.runner });
  const found = await Promise.all(input.sources.map(sourceCertificates(input)));
  const extras = [...new Set(found.flat().map((pem) => pem.trim()))];
  const layout = stateLayout(input.stateDir);
  const pemPath = layout.trustPem;
  const extraPemPath = layout.extraPem;
  const bundle = pemText([ca.certPem, ...extras]);

  await writeIfChanged(extraPemPath, pemText(extras));

  await writeIfChanged(pemPath, bundle);

  return { pemPath, caCertPath: ca.certPath, extraPemPath, hash: sha256Hex(bundle) };
};
