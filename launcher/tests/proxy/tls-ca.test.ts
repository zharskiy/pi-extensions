import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLauncherCa } from "../../proxy/tls-ca.ts";
import { createProcessRunner, LauncherError } from "../../shared/index.ts";

const state = { stateDir: "" };

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
    expect((await first.leaf("llm.example.com")).cert).toBe(firstLeaf.cert);
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
});
