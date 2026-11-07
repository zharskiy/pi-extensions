import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { daemonEnv, recordProxyDynamic } from "../../cli/sandbox-proxy.ts";
import { repoProxyToken } from "../../proxy/index.ts";
import { sha256Hex, stateLayout } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createHarness } from "./harness.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const tokenOf = (index: number) => index.toString(16).padStart(64, "0");

describe("recordProxyDynamic", () => {
  it("keeps every repo's token when many launches write dynamic.json at once", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-dynamic-"));

    cleanups.push(() => rm(stateDir, { recursive: true, force: true }));

    const writes = Array.from({ length: 12 }, (_unused, index) =>
      recordProxyDynamic(stateDir, "policy", {
        version: 1,
        rules: [],
        derivedHosts: [],
        tokens: { [tokenOf(index)]: `repo-${index}` },
      }),
    );

    await Promise.all(writes);

    const written = JSON.parse(await readFile(stateLayout(stateDir).proxyDynamic("policy"), "utf8")) as {
      tokens: Record<string, string>;
    };

    expect(Object.keys(written.tokens)).toHaveLength(12);
  });
});

const ruleFor = (id: string) => ({
  id,
  host: `${id}.example.test`,
  placeholder: `pi-sandbox-${id}`,
  secret: { env: "TOKEN" },
});

describe("recordProxyDynamic for two repositories", () => {
  it("keeps each repository's rules in its own section and the union at the top", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-dynamic-"));

    cleanups.push(() => rm(stateDir, { recursive: true, force: true }));

    const [one, two] = await Promise.all(
      ["1", "2"].map((digit) => repoProxyToken(stateDir, "policy", digit.repeat(64))),
    );
    const write = (token: string, repo: string, id: string) =>
      recordProxyDynamic(stateDir, "policy", {
        version: 1,
        rules: [ruleFor(id)],
        derivedHosts: [`${id}.example.test`],
        tokens: { [sha256Hex(token)]: repo },
      });

    await Promise.all([write(one ?? "", "1".repeat(64), "one"), write(two ?? "", "2".repeat(64), "two")]);

    const written = JSON.parse(await readFile(stateLayout(stateDir).proxyDynamic("policy"), "utf8")) as {
      rules: Array<{ id: string }>;
      derivedHosts: string[];
      repos: Record<string, { rules: Array<{ id: string }> }>;
    };

    expect(written.repos[sha256Hex(one ?? "")]?.rules.map((rule) => rule.id)).toEqual(["one"]);
    expect(written.repos[sha256Hex(two ?? "")]?.rules.map((rule) => rule.id)).toEqual(["two"]);
    expect(written.rules.map((rule) => rule.id).sort()).toEqual(["one", "two"]);
    expect(written.derivedHosts.sort()).toEqual(["one.example.test", "two.example.test"]);
  });
});

describe("daemonEnv", () => {
  it("passes only the variables the daemon needs, never secrets, and strips proxy userinfo", () => {
    const env = daemonEnv({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      TMPDIR: "/tmp",
      NODE_OPTIONS: "--require /fixture/resolve.cjs",
      PI_SANDBOX_STATE_DIR: "/state",
      CORP_TOKEN: "secret-value",
      HTTP_PROXY: "http://user:pw@proxy.example.test:8080",
      HTTPS_PROXY: "http://user:pw@proxy.example.test:8080",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      TMPDIR: "/tmp",
      NODE_OPTIONS: "--require /fixture/resolve.cjs",
      PI_SANDBOX_STATE_DIR: "/state",
      HTTPS_PROXY: "http://proxy.example.test:8080",
    });
  });
});

describe("env-sourced credentials", () => {
  it("refuses a secret value with a line break before the sandbox starts", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      adapters: () => [fake.backend],
      env: { CORP_TOKEN: "abc\r\nX-Evil: 1" },
    });

    cleanups.push(harness.cleanup);

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
    expect(harness.controlMessages).toEqual([]);
    expect(fake.containers.size).toBe(0);
  });
});
