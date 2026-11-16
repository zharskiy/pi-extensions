import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { certificateTime, openLauncherCa } from "../../proxy/tls-ca.ts";
import { createProcessRunner, LauncherError } from "../../shared/index.ts";

const state = { stateDir: "" };

const HOUR_MS = 60 * 60 * 1000;

const LEAF_VALIDITY_MS = 397 * 24 * HOUR_MS;

const CA_VALIDITY_MS = 3650 * 24 * HOUR_MS;

const expectDatedBack = (certificate: X509Certificate, before: number, after: number, validityMs: number) => {
  expect(Date.parse(certificate.validFrom)).toBeGreaterThanOrEqual(before - HOUR_MS - 1000);

  expect(Date.parse(certificate.validFrom)).toBeLessThanOrEqual(after - HOUR_MS);

  expect(Date.parse(certificate.validTo)).toBeGreaterThanOrEqual(before + validityMs - 1000);

  expect(Date.parse(certificate.validTo)).toBeLessThanOrEqual(after + validityMs + 1000);
};

const expectText = async (pem: string, parts: string[]) => {
  const text = await createProcessRunner().run("openssl", ["x509", "-noout", "-text"], { input: pem });

  expect(text.code).toBe(0);

  parts.forEach((part) => {
    expect(text.stdout).toContain(part);
  });
};

beforeAll(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-ca-"));
});

afterAll(async () => {
  await rm(state.stateDir, { recursive: true, force: true });
});

describe("launcher CA", () => {
  it("creates a CA under the state dir and returns the certificate path", async () => {
    const ca = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });
    const authority = new X509Certificate(await readFile(ca.certPath, "utf8"));

    expect(ca.certPath).toBe(join(state.stateDir, "ca", "ca-cert.pem"));
    expect(authority.ca).toBe(true);
  });

  it("signs leaf certificates with the CA", async () => {
    const ca = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });
    const authority = new X509Certificate(ca.certPem);
    const leaf = new X509Certificate((await ca.leaf("llm.example.com")).cert);

    expect(ca.certPath).toBe(join(state.stateDir, "ca", "ca-cert.pem"));

    expect(authority.ca).toBe(true);

    expect(leaf.checkIssued(authority)).toBe(true);

    expect(leaf.subjectAltName).toBe("DNS:llm.example.com");

    expect((await stat(join(state.stateDir, "ca", "ca-key.pem"))).mode & 0o777).toBe(0o600);
  });

  it("reuses the stored CA and keeps leaves in memory only", async () => {
    const first = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });
    const firstLeaf = await first.leaf("llm.example.com");
    const second = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });

    expect(second.certPem).toBe(first.certPem);
    expect(await first.leaf("llm.example.com")).toBe(firstLeaf);
    expect((await second.leaf("llm.example.com")).cert).not.toBe(firstLeaf.cert);
    expect((await readdir(join(state.stateDir, "ca"))).sort()).toEqual(["ca-cert.pem", "ca-key.pem"]);
  });

  it("refuses a leaf for a name that is not a hostname", async () => {
    const ca = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });

    await expect(ca.leaf("../escape")).rejects.toBeInstanceOf(LauncherError);
  });

  it("creates one consistent CA when several launchers open a new state dir at once", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-ca-first-"));

    try {
      const opened = await Promise.all(
        Array.from({ length: 4 }, () => openLauncherCa({ stateDir, runner: createProcessRunner() })),
      );
      const certificate = new X509Certificate(await readFile(join(stateDir, "ca", "ca-cert.pem"), "utf8"));
      const key = createPrivateKey(await readFile(join(stateDir, "ca", "ca-key.pem"), "utf8"));
      const leaf = new X509Certificate((await opened[0]?.leaf("first.test"))?.cert ?? "");

      expect(new Set(opened.map((ca) => ca.certPem)).size).toBe(1);
      expect(opened[0]?.certPem).toBe(certificate.toString());
      expect(certificate.checkPrivateKey(key)).toBe(true);
      expect(leaf.checkIssued(certificate)).toBe(true);
      expect((await readdir(join(stateDir, "ca"))).sort()).toEqual(["ca-cert.pem", "ca-key.pem"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("replaces a CA whose key does not match its certificate and keeps a valid one", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-ca-pair-"));

    try {
      const first = await openLauncherCa({ stateDir, runner: createProcessRunner() });
      const again = await openLauncherCa({ stateDir, runner: createProcessRunner() });

      expect(again.certPem).toBe(first.certPem);

      await writeFile(
        join(stateDir, "ca", "ca-key.pem"),
        String(
          generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
            type: "pkcs8",
            format: "pem",
          }),
        ),
      );

      const replaced = await openLauncherCa({ stateDir, runner: createProcessRunner() });
      const key = createPrivateKey(await readFile(join(stateDir, "ca", "ca-key.pem"), "utf8"));

      expect(replaced.certPem).not.toBe(first.certPem);
      expect(new X509Certificate(replaced.certPem).checkPrivateKey(key)).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("mints one matching key and certificate when several connections ask for the same host at once", async () => {
    const ca = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });
    const leaves = await Promise.all(Array.from({ length: 4 }, () => ca.leaf("race.test")));
    const [leaf] = leaves;

    expect(new Set(leaves.map((entry) => entry.cert)).size).toBe(1);
    expect(leaf === undefined ? undefined : createSecureContext(leaf)).toBeDefined();
  });

  it("issues an in-memory leaf without writing it under the state dir", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-ca-ephemeral-"));
    const ca = await openLauncherCa({ stateDir, runner: createProcessRunner() });
    const leaf = await ca.ephemeralLeaf("denied.test");
    const entries = await readdir(join(stateDir, "ca"));

    await rm(stateDir, { recursive: true, force: true });

    expect(new X509Certificate(leaf.cert).checkIssued(new X509Certificate(ca.certPem))).toBe(true);
    expect(entries.sort()).toEqual(["ca-cert.pem", "ca-key.pem"]);
  });

  it("dates leaves an hour back and keeps their end date 397 days ahead", async () => {
    const ca = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });
    const before = Date.now();
    const leaves = [await ca.leaf("backdated.test"), await ca.ephemeralLeaf("backdated-denial.test")];
    const after = Date.now();

    leaves.forEach((leaf) => {
      expectDatedBack(new X509Certificate(leaf.cert), before, after, LEAF_VALIDITY_MS);
    });
  });

  it("keeps the leaf extensions", async () => {
    const ca = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });
    const leaf = await ca.leaf("extensions.test");
    const certificate = new X509Certificate(leaf.cert);

    expect(certificate.ca).toBe(false);
    expect(certificate.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(certificate.subjectAltName).toBe("DNS:extensions.test");
    expect(certificate.checkIssued(new X509Certificate(ca.certPem))).toBe(true);

    await expectText(leaf.cert, [
      "Key Usage: critical",
      "Digital Signature",
      "Basic Constraints: critical",
      "CA:FALSE",
      "Authority Key Identifier",
    ]);
  });

  it("gives each leaf its own long random serial", async () => {
    const ca = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });
    const serials = [await ca.ephemeralLeaf("serial.test"), await ca.ephemeralLeaf("serial.test")].map(
      (leaf) => new X509Certificate(leaf.cert).serialNumber,
    );

    expect(new Set(serials).size).toBe(2);

    serials.forEach((serial) => {
      expect(BigInt(`0x${serial}`) > 2n ** 64n).toBe(true);

      expect(serial.length).toBeLessThanOrEqual(40);
    });
  });

  it("dates a new CA an hour back and keeps its end date, extensions and key type", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-ca-dated-"));

    try {
      const before = Date.now();
      const ca = await openLauncherCa({ stateDir, runner: createProcessRunner() });
      const after = Date.now();
      const authority = new X509Certificate(ca.certPem);

      expectDatedBack(authority, before, after, CA_VALIDITY_MS);

      expect(authority.ca).toBe(true);
      expect(authority.subject).toBe("CN=pi-sandbox launcher CA");
      expect(authority.issuer).toBe(authority.subject);
      expect(authority.publicKey.asymmetricKeyType).toBe("ec");
      expect(authority.verify(authority.publicKey)).toBe(true);

      await expectText(ca.certPem, [
        "ecdsa-with-SHA256",
        "Basic Constraints: critical",
        "CA:TRUE",
        "Key Usage: critical",
        "Certificate Sign, CRL Sign",
        "Subject Key Identifier",
      ]);

      const leaf = new X509Certificate((await ca.leaf("dated-ca.test")).cert);
      const verified = await createProcessRunner().run("openssl", ["verify", "-CAfile", ca.certPath], {
        input: leaf.toString(),
      });

      expect(leaf.checkIssued(authority)).toBe(true);
      expect(leaf.verify(authority.publicKey)).toBe(true);
      expect(verified.code, verified.stderr).toBe(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps a CA made by an earlier version instead of creating a new one", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-ca-earlier-"));
    const directory = join(stateDir, "ca");
    const runner = createProcessRunner();

    try {
      await mkdir(directory, { recursive: true });

      await writeFile(
        join(directory, "ca.cnf"),
        "[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = pi-sandbox launcher CA\n[ca]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\n",
      );

      await writeFile(
        join(directory, "ca-key.pem"),
        String(
          generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
            type: "pkcs8",
            format: "pem",
          }),
        ),
      );

      const created = await runner.run(
        "openssl",
        [
          "req",
          "-x509",
          "-new",
          "-key",
          "ca-key.pem",
          "-config",
          "ca.cnf",
          "-extensions",
          "ca",
          "-days",
          "3650",
          "-sha256",
          "-out",
          "ca-cert.pem",
        ],
        { cwd: directory },
      );

      await rm(join(directory, "ca.cnf"));

      const earlier = await readFile(join(directory, "ca-cert.pem"), "utf8");
      const ca = await openLauncherCa({ stateDir, runner });

      expect(created.code, created.stderr).toBe(0);
      expect(ca.certPem).toBe(earlier);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("certificateTime", () => {
  it("writes a UTCTime before 2050", () => {
    expect(certificateTime(Date.UTC(2026, 10, 13, 9, 5, 7))).toBe("261113090507Z");

    expect(certificateTime(Date.UTC(2049, 11, 31, 23, 59, 59))).toBe("491231235959Z");
  });

  it("writes a GeneralizedTime from 2050 on", () => {
    expect(certificateTime(Date.UTC(2050, 0, 1, 0, 0, 0))).toBe("20500101000000Z");

    expect(certificateTime(Date.UTC(2061, 4, 2, 3, 4, 5))).toBe("20610502030405Z");
  });
});
