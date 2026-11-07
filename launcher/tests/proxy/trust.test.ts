import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLauncherCa } from "../../proxy/tls-ca.ts";
import { ensureTrustBundle } from "../../proxy/trust.ts";
import { createProcessRunner } from "../../shared/index.ts";
import { argvOf, createScriptedRunner } from "../support/fake-runner.ts";

const state = { stateDir: "", corpPem: "", otherPem: "", launcherPem: "" };

const pemOf = async (stateDir: string) =>
  (await openLauncherCa({ stateDir, runner: createProcessRunner() })).certPem;

const count = (text: string) => (text.match(/BEGIN CERTIFICATE/g) ?? []).length;

beforeAll(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-trust-"));
  state.launcherPem = await pemOf(state.stateDir);
  state.corpPem = await pemOf(join(state.stateDir, "corp"));
  state.otherPem = await pemOf(join(state.stateDir, "other"));
}, 30_000);

afterAll(async () => {
  await rm(state.stateDir, { recursive: true, force: true });
});

describe("ensureTrustBundle", () => {
  it("joins the launcher CA with the host store on macOS and a CA file", async () => {
    const file = join(state.stateDir, "corp.pem");

    await writeFile(file, state.otherPem);

    const fake = createScriptedRunner([
      { argv: ["security", "find-certificate"], result: { stdout: `${state.corpPem}\n${state.corpPem}` } },
    ]);
    const bundle = await ensureTrustBundle({
      stateDir: state.stateDir,
      runner: fake.runner,
      platform: "darwin",
      sources: [{ hostStore: true }, { file }],
    });
    const pem = await readFile(bundle.pemPath, "utf8");

    expect(fake.calls.map(argvOf)).toEqual([
      ["security", "find-certificate", "-a", "-p", "/Library/Keychains/System.keychain"],
    ]);
    expect(bundle.pemPath).toBe(join(state.stateDir, "ca", "trust.pem"));
    expect(count(pem)).toBe(3);
    expect(pem.startsWith(state.launcherPem.trim())).toBe(true);
    expect(count(await readFile(bundle.extraPemPath, "utf8"))).toBe(2);
    expect(new X509Certificate(state.corpPem).ca).toBe(true);
  });

  it("skips the host store outside macOS and changes the hash with the content", async () => {
    const fake = createScriptedRunner([]);
    const plain = await ensureTrustBundle({
      stateDir: state.stateDir,
      runner: fake.runner,
      platform: "linux",
      sources: [{ hostStore: true }],
    });
    const again = await ensureTrustBundle({
      stateDir: state.stateDir,
      runner: fake.runner,
      platform: "linux",
      sources: [],
    });

    expect(fake.calls).toEqual([]);
    expect(count(await readFile(plain.pemPath, "utf8"))).toBe(1);
    expect(again.hash).toBe(plain.hash);
    expect((await stat(plain.pemPath)).mode & 0o777).toBe(0o644);
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
