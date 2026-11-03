import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
