import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureLauncherCa } from "../../proxy/index.ts";
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
    const ca = await ensureLauncherCa(state.stateDir, createProcessRunner());
    const authority = new X509Certificate(await readFile(ca.certPemPath, "utf8"));

    expect(ca.certPemPath).toBe(join(state.stateDir, "ca", "ca-cert.pem"));
    expect(authority.ca).toBe(true);
  });

  it("signs leaf certificates with the CA", async () => {
    const ca = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });
    const authority = new X509Certificate(ca.certPem);
    const leaf = new X509Certificate((await ca.leaf("gateway.example.com")).cert);

    expect(ca.certPath).toBe(join(state.stateDir, "ca", "ca-cert.pem"));

    expect(authority.ca).toBe(true);

    expect(leaf.checkIssued(authority)).toBe(true);

    expect(leaf.subjectAltName).toBe("DNS:gateway.example.com");

    expect((await stat(join(state.stateDir, "ca", "ca-key.pem"))).mode & 0o777).toBe(0o600);
  });

  it("reuses the cached CA and leaf", async () => {
    const first = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });
    const firstLeaf = await first.leaf("gateway.example.com");
    const second = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });

    expect(second.certPem).toBe(first.certPem);

    expect((await second.leaf("gateway.example.com")).cert).toBe(firstLeaf.cert);
  });

  it("refuses a leaf for a name that is not a hostname", async () => {
    const ca = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });

    await expect(ca.leaf("../escape")).rejects.toBeInstanceOf(LauncherError);
  });

  it("mints one matching key and certificate when two daemons ask for the same host at once", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-ca-race-"));
    const first = await openLauncherCa({ stateDir, runner: createProcessRunner() });
    const second = await openLauncherCa({ stateDir, runner: createProcessRunner() });
    const leaves = await Promise.all([
      first.leaf("race.test"),
      second.leaf("race.test"),
      first.leaf("race.test"),
      second.leaf("race.test"),
    ]);
    const onDisk = {
      key: await readFile(join(stateDir, "ca", "leaf", "race.test-key.pem"), "utf8"),
      cert: await readFile(join(stateDir, "ca", "leaf", "race.test-cert.pem"), "utf8"),
    };

    await rm(stateDir, { recursive: true, force: true });

    expect(new Set(leaves.map((leaf) => leaf.cert)).size).toBe(1);
    expect(leaves[0]).toEqual(onDisk);
    expect(createSecureContext(onDisk)).toBeDefined();
  });

  it("mints again when the stored key does not match the stored certificate", async () => {
    const ca = await openLauncherCa({ stateDir: state.stateDir, runner: createProcessRunner() });
    const before = await ca.leaf("mismatch.test");
    const keyPath = join(state.stateDir, "ca", "leaf", "mismatch.test-key.pem");

    await writeFile(
      keyPath,
      String(
        generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
      ),
    );

    const after = await ca.leaf("mismatch.test");

    expect(after.cert).not.toBe(before.cert);
    expect(after.key).toBe(await readFile(keyPath, "utf8"));
    expect(createSecureContext(after)).toBeDefined();
  });

  it("issues an in-memory leaf without writing it under the state dir", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-ca-ephemeral-"));
    const ca = await openLauncherCa({ stateDir, runner: createProcessRunner() });
    const leaf = await ca.ephemeralLeaf("denied.test");
    const entries = await readdir(join(stateDir, "ca"));

    await rm(stateDir, { recursive: true, force: true });

    expect(new X509Certificate(leaf.cert).checkIssued(new X509Certificate(ca.certPem))).toBe(true);
    expect(entries.sort()).toEqual(["ca-cert.pem", "ca-key.pem", "ca.cnf"]);
  });

  it("prunes expired or unreadable leaves and keeps valid ones", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-ca-prune-"));
    const runner = createProcessRunner();
    const ca = await openLauncherCa({ stateDir, runner });
    const leafDir = join(stateDir, "ca", "leaf");

    await ca.leaf("kept.test");

    await mkdir(leafDir, { recursive: true });

    await writeFile(join(leafDir, "garbage.test-cert.pem"), "not a certificate");

    await writeFile(join(leafDir, "garbage.test-key.pem"), "not a key");

    await writeFile(join(leafDir, "old.test.cnf"), "[req]");

    await runner.run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-subj",
      "/CN=short.test",
      "-days",
      "1",
      "-keyout",
      join(leafDir, "short.test-key.pem"),
      "-out",
      join(leafDir, "short.test-cert.pem"),
    ]);

    await ca.pruneLeaves();

    const left = await readdir(leafDir);

    await rm(stateDir, { recursive: true, force: true });

    expect(left.sort()).toEqual(["kept.test-cert.pem", "kept.test-key.pem"]);
  });
});
