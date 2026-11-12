import { X509Certificate } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
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
  now?: number;
}

export interface TrustBundle {
  pemPath: string;
  caCertPath: string;
  extraPemPath: string;
  hash: string;
}

interface Found {
  pem: string;
  certificate: X509Certificate;
  label: string;
}

const MACOS_KEYCHAINS = ["/Library/Keychains/System.keychain", "login.keychain"];

const PUBLIC_MODE = 0o644;

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

const FILE_HINT = 'export the CA to a PEM file and list it as { "file": "~/ca.pem" }';

const parsed = (pem: string) => {
  try {
    return new X509Certificate(pem);
  } catch {
    return undefined;
  }
};

const certificatesIn = (text: string) =>
  (text.match(PEM_BLOCK) ?? []).flatMap((pem) => {
    const certificate = parsed(pem);

    return certificate === undefined ? [] : [{ pem, certificate }];
  });

const bareFingerprint = (value: string) => value.replaceAll(":", "").toUpperCase();

const subjectOf = (certificate: X509Certificate) => certificate.subject.split("\n").join(", ");

const dayOf = (date: string) => new Date(date).toISOString().slice(0, 10);

const isSelfSigned = (certificate: X509Certificate) =>
  certificate.issuer === certificate.subject && certificate.verify(certificate.publicKey);

const usableProblem = (certificate: X509Certificate, now: number) => {
  if (!certificate.ca && !isSelfSigned(certificate)) {
    return "which is not a CA";
  }

  if (Date.parse(certificate.validTo) < now) {
    return `which expired on ${dayOf(certificate.validTo)}`;
  }

  return Date.parse(certificate.validFrom) > now
    ? `which is valid only from ${dayOf(certificate.validFrom)}`
    : undefined;
};

const checkUsable = (now: number) => (found: Found) => {
  const problem = usableProblem(found.certificate, now);

  if (problem !== undefined) {
    throw new LauncherError(`tls.extraCa: ${found.label} ${subjectOf(found.certificate)}, ${problem}`);
  }

  return found.pem;
};

const fileCertificates = async (file: string): Promise<Found[]> => {
  const path = expandHome(file, homedir());
  const text = await readFile(path, "utf8").catch(() => undefined);

  if (text === undefined) {
    throw new LauncherError(`tls.extraCa: ${path} is not readable`, "fix the path or remove the entry");
  }

  const found = certificatesIn(text);

  if (found.length === 0) {
    throw new LauncherError(`tls.extraCa: ${path} holds no PEM certificate`);
  }

  return found.map((entry) => ({ ...entry, label: `${path} holds` }));
};

interface KeychainReading {
  certificates: ReturnType<typeof certificatesIn>;
  unreadable: string[];
}

const keychainCertificates = async (runner: CommandRunner, keychain: string): Promise<KeychainReading> => {
  const result = await runner
    .run("security", ["find-certificate", "-a", "-p", keychain])
    .catch(() => undefined);

  return result?.code === 0
    ? { certificates: certificatesIn(result.stdout), unreadable: [] }
    : { certificates: [], unreadable: [keychain] };
};

const keychainReader = (input: TrustBundleInput) => {
  let loaded: Promise<KeychainReading> | undefined;

  return () => {
    loaded ??= Promise.all(
      MACOS_KEYCHAINS.map((keychain) => keychainCertificates(input.runner, keychain)),
    ).then((readings) => ({
      certificates: readings.flatMap((reading) => reading.certificates),
      unreadable: readings.flatMap((reading) => reading.unreadable),
    }));

    return loaded;
  };
};

const unreadableNote = (unreadable: string[]) =>
  unreadable.length === 0 ? "" : ` (security find-certificate could not read ${unreadable.join(", ")})`;

const fingerprintCertificates = async (
  fingerprint: string,
  platform: NodeJS.Platform,
  keychains: ReturnType<typeof keychainReader>,
): Promise<Found[]> => {
  if (platform !== "darwin") {
    throw new LauncherError(
      `tls.extraCa: sha256 ${fingerprint} is looked up in the macOS keychains, and this host is ${platform}`,
      FILE_HINT,
    );
  }

  const wanted = bareFingerprint(fingerprint);
  const { certificates, unreadable } = await keychains();
  const match = certificates.find((entry) => bareFingerprint(entry.certificate.fingerprint256) === wanted);

  if (match === undefined) {
    throw new LauncherError(
      `tls.extraCa: no certificate with sha256 ${fingerprint} in the macOS keychains${unreadableNote(unreadable)}`,
      `run pi sandbox doctor to get the sha256 of your network's CA; for a CA that is not in a keychain, ${FILE_HINT}`,
    );
  }

  return [{ ...match, label: `sha256 ${fingerprint} is` }];
};

const sourceCertificates = (input: TrustBundleInput) => {
  const keychains = keychainReader(input);

  return (source: ExtraCa) =>
    "file" in source
      ? fileCertificates(source.file)
      : fingerprintCertificates(source.sha256, input.platform, keychains);
};

const writeIfChanged = async (path: string, text: string) => {
  const current = await readFile(path, "utf8").catch(() => undefined);

  if (current !== text) {
    await writeFileAtomic(path, text, { mode: PUBLIC_MODE });
  }
};

const pemText = (certificates: string[]) => certificates.map((pem) => `${pem.trim()}\n`).join("");

export const ensureTrustBundle = async (input: TrustBundleInput): Promise<TrustBundle> => {
  const found = await Promise.all(input.sources.map(sourceCertificates(input)));
  const usable = found.flat().map(checkUsable(input.now ?? Date.now()));
  const extras = [...new Set(usable.map((pem) => pem.trim()))];
  const ca = await openLauncherCa({ stateDir: input.stateDir, runner: input.runner });
  const layout = stateLayout(input.stateDir);
  const pemPath = layout.trustPem;
  const extraPemPath = layout.extraPem;
  const bundle = pemText([ca.certPem, ...extras]);

  await writeIfChanged(extraPemPath, pemText(extras));

  await writeIfChanged(pemPath, bundle);

  await rm(layout.legacyTrustPem, { force: true });

  return { pemPath, caCertPath: ca.certPath, extraPemPath, hash: sha256Hex(bundle) };
};
