import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { createFakeBackend, createHarness } from "./harness.ts";

describe("env-sourced credentials", () => {
  it("refuses a secret value with a line break before the sandbox starts", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
      env: { CORP_TOKEN: "abc\r\nX-Evil: 1" },
    });

    await harness.writeJson(harness.userConfigFile, {
      credentials: {
        rules: [
          {
            id: "corp",
            host: "corp.example.test",
            placeholder: "pi-sandbox-corp",
            secret: { env: "CORP_TOKEN" },
          },
        ],
      },
    });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      "pi-sandbox: CORP_TOKEN contains a line break and cannot be used as a credential",
    );
    expect(harness.proxyInputs).toEqual([]);
    expect(fake.containers.size).toBe(0);
  });
});

describe("env parent proxy", () => {
  it("warns that an https parent proxy is not used and the proxy connects directly", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
      env: { HTTPS_PROXY: "https://proxy.example.test:443" },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain(
      "pi-sandbox: parent proxy: HTTPS_PROXY uses https, only http parent proxies are supported; the proxy connects directly\n",
    );
  });

  it("says nothing for an http parent proxy", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
      env: { HTTPS_PROXY: "http://proxy.example.test:8080" },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).not.toContain("egress.parentProxy");
  });
});

describe("denial lines", () => {
  it("offers a grant only for allowlist and port denials, and names the reason for anything else", async () => {
    const fake = createFakeBackend();
    const denial = (host: string, rule: string, reason: string) => ({
      time: 1_700_000_000_500,
      host,
      port: 443,
      repoHash: "repo",
      rule,
      reason,
    });
    const harness = await createHarness({
      backend: () => fake.backend,
      denials: [
        denial("allow.test", "egress.allow", "not allowed"),
        denial("capped.test", "egress.cap", "too many denial pages"),
      ],
    });

    await run([], harness.deps);

    expect(harness.stderr()).toContain(
      `pi-sandbox: allow.test was blocked in this folder's sandbox; run pi sandbox egress allow allow.test on the host from ${harness.repoRoot}\n`,
    );
    expect(harness.stderr()).toContain(
      "pi-sandbox: capped.test was blocked in this folder's sandbox; too many denial pages\n",
    );
  });
});
