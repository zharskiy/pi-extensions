import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStateDir, openCa, removeDir, startTestProxy, type TestProxy } from "./harness.ts";
import { secureTunnel } from "./proxy-client.ts";

const HOST = "api.test";

const REPO = "2".repeat(64);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const servedSerial = async (test: TestProxy, ca: string) => {
  const secure = await secureTunnel(test.proxy.port, `${HOST}:443`, HOST, ca, await test.tokenOf(REPO));
  const serial = secure.getPeerCertificate().serialNumber;

  secure.destroy();

  return serial;
};

const proxyServing = async (leafRecheckMs: number) => {
  const stateDir = await createStateDir();
  const ca = await openCa(stateDir);
  const test = await startTestProxy({
    stateDir,
    ca,
    policy: { allow: [`${HOST}:443`] },
    rules: [
      { id: "api", host: HOST, placeholder: "pi-sandbox-0123456789abcdef01234567", secret: { env: "API" } },
    ],
    leafRecheckMs,
  });

  cleanups.push(async () => {
    await test.proxy.close();

    await removeDir(stateDir);
  });

  const renew = async () => {
    const renewed = await ca.ephemeralLeaf(HOST);
    const base = join(stateDir, "ca", "leaf", HOST);

    await writeFile(`${base}-key.pem`, renewed.key);

    await writeFile(`${base}-cert.pem`, renewed.cert);
  };

  return { test, ca, renew };
};

describe("the certificate the proxy presents for a terminated host", () => {
  it("serves a renewed leaf from disk without a daemon restart", async () => {
    const { test, ca, renew } = await proxyServing(0);
    const first = await servedSerial(test, ca.certPem);

    await renew();

    const second = await servedSerial(test, ca.certPem);

    expect(second).not.toBe(first);
  });

  it("keeps serving the cached leaf between checks", async () => {
    const { test, ca, renew } = await proxyServing(60_000);
    const first = await servedSerial(test, ca.certPem);

    await renew();

    expect(await servedSerial(test, ca.certPem)).toBe(first);
  });
});
