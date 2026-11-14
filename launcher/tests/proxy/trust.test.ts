import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endLaunch, registerLaunch } from "../../grants/index.ts";
import { openLauncherCa } from "../../proxy/tls-ca.ts";
import { ensureTrustBundle } from "../../proxy/trust.ts";
import { createProcessRunner, LauncherError, processMark } from "../../shared/index.ts";
import { argvOf, createScriptedRunner } from "../support/fake-runner.ts";

const state = { stateDir: "", corpPem: "", otherPem: "", launcherPem: "", leafPem: "", plainRootPem: "" };

const openssl = promisify(execFile);

const SYSTEM = "/Library/Keychains/System.keychain";

const LOGIN = "login.keychain";

const openCa = (stateDir: string) => openLauncherCa({ stateDir, runner: createProcessRunner() });

const count = (text: string) => (text.match(/BEGIN CERTIFICATE/g) ?? []).length;

const fingerprintOf = (pem: string) => new X509Certificate(pem).fingerprint256;

const keychains = (system: string, login: string) =>
  createScriptedRunner([
    { argv: ["security", "find-certificate", "-a", "-p", SYSTEM], result: { stdout: system } },
    { argv: ["security", "find-certificate", "-a", "-p", LOGIN], result: { stdout: login } },
  ]);

const plainSelfSigned = async (dir: string) => {
  const key = join(dir, "plain.key");
  const csr = join(dir, "plain.csr");
  const pem = join(dir, "plain.pem");

  await openssl("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);

  await openssl("openssl", ["req", "-new", "-key", key, "-subj", "/CN=Plain Root", "-out", csr]);

  await openssl("openssl", ["x509", "-req", "-in", csr, "-signkey", key, "-days", "2", "-out", pem]);

  return readFile(pem, "utf8");
};

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof LauncherError
      ? { message: error.message, hint: error.hint }
      : { message: String(error) };
  }

  return undefined;
};

beforeAll(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-trust-"));
  state.launcherPem = (await openCa(state.stateDir)).certPem;
  state.corpPem = (await openCa(join(state.stateDir, "corp"))).certPem;

  const other = await openCa(join(state.stateDir, "other"));

  state.otherPem = other.certPem;
  state.leafPem = (await other.leaf("llm.example.com")).cert;
  state.plainRootPem = await plainSelfSigned(state.stateDir);
}, 30_000);

afterAll(async () => {
  await rm(state.stateDir, { recursive: true, force: true });
});

describe("ensureTrustBundle", () => {
  it("finds a sha256 entry in the System keychain and joins it with the launcher CA and a CA file", async () => {
    const file = join(state.stateDir, "corp.pem");

    await writeFile(file, state.otherPem);

    const fake = keychains(`${state.leafPem}\n${state.corpPem}`, "");
    const bundle = await ensureTrustBundle({
      stateDir: state.stateDir,
      runner: fake.runner,
      platform: "darwin",
      sources: [{ sha256: fingerprintOf(state.corpPem) }, { file }],
    });
    const pem = await readFile(bundle.pemPath, "utf8");

    expect(fake.calls.map(argvOf)).toEqual([
      ["security", "find-certificate", "-a", "-p", SYSTEM],
      ["security", "find-certificate", "-a", "-p", LOGIN],
    ]);
    expect(bundle.pemPath).toMatch(
      new RegExp(`^${join(state.stateDir, "vm")}/trust-${bundle.hash.slice(0, 12)}-[0-9a-f]{16}\\.pem$`),
    );
    expect(count(pem)).toBe(3);
    expect(pem.startsWith(state.launcherPem.trim())).toBe(true);
    expect(pem).not.toContain(state.leafPem.trim());
    expect(count(await readFile(bundle.extraPemPath, "utf8"))).toBe(2);
  });

  it("finds a sha256 entry in the login keychain, without colons and in any case, reading the keychains once", async () => {
    const fake = keychains(state.otherPem, state.corpPem);
    const fingerprint = fingerprintOf(state.corpPem).replaceAll(":", "");
    const bundle = await ensureTrustBundle({
      stateDir: state.stateDir,
      runner: fake.runner,
      platform: "darwin",
      sources: [{ sha256: fingerprint.toLowerCase() }, { sha256: fingerprint }],
    });
    const extra = await readFile(bundle.extraPemPath, "utf8");

    expect(fake.calls).toHaveLength(2);
    expect(count(extra)).toBe(1);
    expect(extra.trim()).toBe(state.corpPem.trim());
  });

  it("names a fingerprint that is in no keychain and points at the doctor and a CA file", async () => {
    const missing = "ab".repeat(32);

    expect(
      await failureOf(
        ensureTrustBundle({
          stateDir: state.stateDir,
          runner: keychains(state.corpPem, state.otherPem).runner,
          platform: "darwin",
          sources: [{ sha256: missing }],
        }),
      ),
    ).toEqual({
      message: `tls.extraCa: no certificate with sha256 ${missing} in the macOS keychains`,
      hint: `run pi sandbox doctor to get the sha256 of your network's CA; for a CA that is not in a keychain, export the CA to a PEM file and list it as { "file": "~/ca.pem" }`,
    });
  });

  it("refuses a certificate that is not a CA, from a file or a keychain", async () => {
    const file = join(state.stateDir, "leaf.pem");
    const subject = new X509Certificate(state.leafPem).subject.split("\n").join(", ");

    await writeFile(file, state.leafPem);

    expect(
      (
        await failureOf(
          ensureTrustBundle({
            stateDir: state.stateDir,
            runner: createScriptedRunner([]).runner,
            platform: "linux",
            sources: [{ file }],
          }),
        )
      )?.message,
    ).toBe(`tls.extraCa: ${file} holds ${subject}, which is not a CA`);
    expect(
      (
        await failureOf(
          ensureTrustBundle({
            stateDir: state.stateDir,
            runner: keychains(state.leafPem, "").runner,
            platform: "darwin",
            sources: [{ sha256: fingerprintOf(state.leafPem) }],
          }),
        )
      )?.message,
    ).toBe(`tls.extraCa: sha256 ${fingerprintOf(state.leafPem)} is ${subject}, which is not a CA`);
  });

  it("accepts a self-signed root that carries no CA flag", async () => {
    const file = join(state.stateDir, "plain-root.pem");

    await writeFile(file, state.plainRootPem);

    expect(new X509Certificate(state.plainRootPem).ca).toBe(false);

    const bundle = await ensureTrustBundle({
      stateDir: state.stateDir,
      runner: createScriptedRunner([]).runner,
      platform: "linux",
      sources: [{ file }],
    });

    expect((await readFile(bundle.extraPemPath, "utf8")).trim()).toBe(state.plainRootPem.trim());
  });

  it("finds the certificate in one keychain when the other cannot be read", async () => {
    const fake = createScriptedRunner([
      { argv: ["security", "find-certificate", "-a", "-p", SYSTEM], result: { code: 50, stderr: "denied" } },
      { argv: ["security", "find-certificate", "-a", "-p", LOGIN], result: { stdout: state.corpPem } },
    ]);
    const bundle = await ensureTrustBundle({
      stateDir: state.stateDir,
      runner: fake.runner,
      platform: "darwin",
      sources: [{ sha256: fingerprintOf(state.corpPem) }],
    });

    expect((await readFile(bundle.extraPemPath, "utf8")).trim()).toBe(state.corpPem.trim());
  });

  it("names the keychain it could not read when no keychain holds the certificate", async () => {
    const missing = "cd".repeat(32);
    const fake = createScriptedRunner([
      { argv: ["security", "find-certificate", "-a", "-p", SYSTEM], result: { stdout: state.otherPem } },
      { argv: ["security", "find-certificate", "-a", "-p", LOGIN], result: { code: 51 } },
    ]);

    expect(
      (
        await failureOf(
          ensureTrustBundle({
            stateDir: state.stateDir,
            runner: fake.runner,
            platform: "darwin",
            sources: [{ sha256: missing }],
          }),
        )
      )?.message,
    ).toBe(
      `tls.extraCa: no certificate with sha256 ${missing} in the macOS keychains (security find-certificate could not read ${LOGIN})`,
    );
  });

  it("refuses an expired CA and names its subject and expiry date", async () => {
    const file = join(state.stateDir, "expired.pem");
    const certificate = new X509Certificate(state.corpPem);
    const expiry = new Date(certificate.validTo);

    await writeFile(file, state.corpPem);

    expect(
      (
        await failureOf(
          ensureTrustBundle({
            stateDir: state.stateDir,
            runner: createScriptedRunner([]).runner,
            platform: "linux",
            sources: [{ file }],
            now: expiry.getTime() + 1000,
          }),
        )
      )?.message,
    ).toBe(
      `tls.extraCa: ${file} holds ${certificate.subject.split("\n").join(", ")}, which expired on ${expiry.toISOString().slice(0, 10)}`,
    );
  });

  it("refuses a sha256 entry outside macOS and points at a CA file", async () => {
    const fake = createScriptedRunner([]);
    const fingerprint = fingerprintOf(state.corpPem);

    expect(
      await failureOf(
        ensureTrustBundle({
          stateDir: state.stateDir,
          runner: fake.runner,
          platform: "linux",
          sources: [{ sha256: fingerprint }],
        }),
      ),
    ).toEqual({
      message: `tls.extraCa: sha256 ${fingerprint} is looked up in the macOS keychains, and this host is linux`,
      hint: 'export the CA to a PEM file and list it as { "file": "~/ca.pem" }',
    });
    expect(fake.calls).toEqual([]);
  });

  it("writes only the launcher CA without extra sources and changes the hash with the content", async () => {
    const fake = createScriptedRunner([]);
    const file = join(state.stateDir, "other.pem");

    await writeFile(file, state.otherPem);

    const plain = await ensureTrustBundle({
      stateDir: state.stateDir,
      runner: fake.runner,
      platform: "linux",
      sources: [],
    });
    const plainCount = count(await readFile(plain.pemPath, "utf8"));
    const extended = await ensureTrustBundle({
      stateDir: state.stateDir,
      runner: fake.runner,
      platform: "linux",
      sources: [{ file }],
    });

    expect(fake.calls).toEqual([]);
    expect(plainCount).toBe(1);
    expect(count(await readFile(extended.pemPath, "utf8"))).toBe(2);
    expect(extended.hash).not.toBe(plain.hash);
    expect((await stat(extended.pemPath)).mode & 0o777).toBe(0o644);
  });

  it("refuses a CA file that is missing", async () => {
    await expect(
      ensureTrustBundle({
        stateDir: state.stateDir,
        runner: createScriptedRunner([]).runner,
        platform: "linux",
        sources: [{ file: join(state.stateDir, "missing.pem") }],
      }),
    ).rejects.toThrow("is not readable");
  });
});

describe("the legacy trust.pem", () => {
  const legacyPem = () => join(state.stateDir, "ca", "trust.pem");

  const bundleFor = (launchId: string) =>
    ensureTrustBundle({
      stateDir: state.stateDir,
      runner: keychains("", "").runner,
      platform: "darwin",
      sources: [],
      launchId,
    });

  it("stays while another launch may still bind it, and goes once only this launch is live", async () => {
    const mark = await processMark();

    await mkdir(join(state.stateDir, "ca"), { recursive: true });

    await writeFile(legacyPem(), "old");

    await registerLaunch(state.stateDir, {
      launchId: "00000000000000a1",
      ...mark,
      repoHash: "a".repeat(64),
      startedAt: 1,
    });

    await registerLaunch(state.stateDir, {
      launchId: "00000000000000a2",
      ...mark,
      repoHash: "b".repeat(64),
      startedAt: 1,
    });

    await bundleFor("00000000000000a1");

    expect(await readFile(legacyPem(), "utf8")).toBe("old");

    await endLaunch(state.stateDir, {
      repoHash: "b".repeat(64),
      launchId: "00000000000000a2",
      onLast: async () => undefined,
    });

    await bundleFor("00000000000000a1");

    expect(await stat(legacyPem()).catch(() => undefined)).toBeUndefined();
  });
});

describe("the trust bundle files", () => {
  const SELF = "00000000000000b1";

  const OTHER = "00000000000000b2";

  const bundleIn = (stateDir: string, sources: Array<{ file: string }>, launchId = SELF) =>
    ensureTrustBundle({
      stateDir,
      runner: createProcessRunner(),
      platform: "linux",
      sources,
      launchId,
    });

  const register = async (stateDir: string, launchId: string, repoHash: string) =>
    registerLaunch(stateDir, { launchId, ...(await processMark()), repoHash, startedAt: 1 });

  const endOther = (stateDir: string) =>
    endLaunch(stateDir, { repoHash: "d".repeat(64), launchId: OTHER, onLast: async () => undefined });

  const trustFiles = async (stateDir: string) =>
    (await readdir(join(stateDir, "vm"))).filter((name) => name.startsWith("trust")).sort();

  const withStateDir = async (action: (stateDir: string) => Promise<void>) => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-trust-files-"));

    try {
      await action(stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  };

  it("leaves an earlier bundle untouched while another launch is live and removes it once alone", () =>
    withStateDir(async (stateDir) => {
      const file = join(stateDir, "corp.pem");

      await writeFile(file, state.corpPem);

      await register(stateDir, SELF, "c".repeat(64));

      await register(stateDir, OTHER, "d".repeat(64));

      const first = await bundleIn(stateDir, []);
      const firstText = await readFile(first.pemPath, "utf8");
      const firstInode = (await stat(first.pemPath)).ino;

      await writeFile(join(stateDir, "vm", "trust.pem"), "unversioned");

      await writeFile(join(stateDir, "vm", `trust-${first.hash.slice(0, 12)}.pem`), "first version");

      const second = await bundleIn(stateDir, [{ file }]);

      expect(second.pemPath).not.toBe(first.pemPath);
      expect(await readFile(first.pemPath, "utf8")).toBe(firstText);
      expect((await stat(first.pemPath)).ino).toBe(firstInode);
      expect(count(await readFile(second.pemPath, "utf8"))).toBe(2);

      await endOther(stateDir);

      const third = await bundleIn(stateDir, [{ file }]);

      expect(third.pemPath).toBe(second.pemPath);
      expect(await trustFiles(stateDir)).toEqual([basename(second.pemPath)]);
    }));

  it("gives concurrent launches with the same content one file", () =>
    withStateDir(async (stateDir) => {
      await openCa(stateDir);

      await register(stateDir, SELF, "c".repeat(64));

      await register(stateDir, OTHER, "d".repeat(64));

      const bundles = await Promise.all([bundleIn(stateDir, []), bundleIn(stateDir, [], OTHER)]);

      expect(new Set(bundles.map((bundle) => bundle.pemPath)).size).toBe(1);
      expect(await trustFiles(stateDir)).toEqual([basename(bundles[0]?.pemPath ?? "")]);
    }));

  it("reuses the file of the same content while it exists", () =>
    withStateDir(async (stateDir) => {
      const first = await bundleIn(stateDir, []);
      const before = await stat(first.pemPath);
      const second = await bundleIn(stateDir, []);
      const after = await stat(second.pemPath);

      expect(second.pemPath).toBe(first.pemPath);
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    }));

  it("never writes a path twice when a content comes back after its file was removed", () =>
    withStateDir(async (stateDir) => {
      const file = join(stateDir, "corp.pem");

      await writeFile(file, state.corpPem);

      const first = await bundleIn(stateDir, []);
      const second = await bundleIn(stateDir, [{ file }]);
      const third = await bundleIn(stateDir, []);

      expect(third.hash).toBe(first.hash);
      expect(new Set([first.pemPath, second.pemPath, third.pemPath]).size).toBe(3);
      expect(await trustFiles(stateDir)).toEqual([basename(third.pemPath)]);
    }));

  it("writes a new file instead of rewriting a damaged one", () =>
    withStateDir(async (stateDir) => {
      await register(stateDir, SELF, "c".repeat(64));

      await register(stateDir, OTHER, "d".repeat(64));

      const first = await bundleIn(stateDir, []);
      const text = await readFile(first.pemPath, "utf8");

      await writeFile(first.pemPath, "damaged");

      const second = await bundleIn(stateDir, []);

      expect(second.pemPath).not.toBe(first.pemPath);
      expect(await readFile(second.pemPath, "utf8")).toBe(text);
      expect(await readFile(first.pemPath, "utf8")).toBe("damaged");

      await endOther(stateDir);

      await bundleIn(stateDir, []);

      expect(await trustFiles(stateDir)).toEqual([basename(second.pemPath)]);
    }));
});
