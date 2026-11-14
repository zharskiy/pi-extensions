import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SecretRef } from "../../config/index.ts";
import { commandSecret } from "../../proxy/secrets/command.ts";
import {
  createSecretResolver,
  envSecretsFor,
  parentProxyAuth,
  type SecretResolverDeps,
} from "../../proxy/secrets/index.ts";
import { createProcessRunner } from "../../shared/index.ts";
import { createFakeClock } from "../support/fake-clock.ts";
import { argvOf, createFakeRunner, type FakeResponder } from "../support/fake-runner.ts";
import { tempDir } from "../support/temp-dir.ts";

const PI = ["/usr/bin/node", "/opt/pi/cli.js"];

const state = { home: "" };

beforeEach(async () => {
  state.home = await tempDir("secrets");
});

const setup = (respond: FakeResponder = () => ({ stdout: "" }), extra: Partial<SecretResolverDeps> = {}) => {
  const fake = createFakeRunner(respond);
  const clock = createFakeClock();
  const resolver = createSecretResolver({
    runner: fake.runner,
    home: state.home,
    now: clock.now,
    piCommand: PI,
    stateDir: join(state.home, "state"),
    hostAgentDir: join(state.home, ".pi", "agent"),
    envSecrets: new Map(),
    ...extra,
  });

  return { fake, clock, resolver };
};

const secretOf = async (resolver: ReturnType<typeof setup>["resolver"], key: string, ref: SecretRef) => {
  const result = await resolver.resolve(key, ref);

  return result.ok ? result.value : `unavailable: ${result.reason}`;
};

describe("command secrets", () => {
  it("trims the output and caches it for the default 300 s", async () => {
    const { fake, clock, resolver } = setup(() => ({ stdout: "  token-1\n" }));

    expect(await secretOf(resolver, "rule", { command: ["get-token", "--quiet"] })).toBe("token-1");

    clock.advance(299_000);

    await resolver.resolve("rule", { command: ["get-token", "--quiet"] });

    expect(fake.calls).toHaveLength(1);

    clock.advance(2_000);

    await resolver.resolve("rule", { command: ["get-token", "--quiet"] });

    expect(fake.calls.map(argvOf)).toEqual([
      ["get-token", "--quiet"],
      ["get-token", "--quiet"],
    ]);
  });

  it("keeps a plain token for 300 s and a JSON token until its expiresAt, less 30 s", async () => {
    const { fake, clock, resolver } = setup((call) =>
      call.file === "json-token"
        ? {
            stdout: JSON.stringify({ token: "jwt", expiresAt: new Date(clock.now() + 40_000).toISOString() }),
          }
        : { stdout: "short" },
    );

    expect(await secretOf(resolver, "json", { command: ["json-token"] })).toBe("jwt");

    await resolver.resolve("short", { command: ["short-token"] });

    clock.advance(11_000);

    await resolver.resolve("json", { command: ["json-token"] });

    await resolver.resolve("short", { command: ["short-token"] });

    clock.advance(288_000);

    await resolver.resolve("short", { command: ["short-token"] });

    clock.advance(2_000);

    await resolver.resolve("short", { command: ["short-token"] });

    expect(fake.calls.map((call) => call.file)).toEqual([
      "json-token",
      "short-token",
      "json-token",
      "short-token",
    ]);
  });

  it("reads expiresAt only as an ISO 8601 time and keeps the 300 s for a number", async () => {
    const { fake, clock, resolver } = setup(() => ({
      stdout: JSON.stringify({ token: "jwt", expiresAt: clock.now() + 40_000 }),
    }));

    await resolver.resolve("json", { command: ["json-token"] });

    clock.advance(45_000);

    await resolver.resolve("json", { command: ["json-token"] });

    expect(fake.calls).toHaveLength(1);
  });

  it("runs the command once for concurrent requests", async () => {
    const { fake, resolver } = setup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));

      return { stdout: "shared" };
    });
    const values = await Promise.all([1, 2, 3].map(() => secretOf(resolver, "rule", { command: ["slow"] })));

    expect(values).toEqual(["shared", "shared", "shared"]);
    expect(fake.calls).toHaveLength(1);
  });

  it("runs the command again after invalidate", async () => {
    const { fake, resolver } = setup(() => ({ stdout: "again" }));

    await resolver.resolve("rule", { command: ["get"] });

    resolver.invalidate("rule");

    await resolver.resolve("rule", { command: ["get"] });

    expect(fake.calls).toHaveLength(2);
  });

  it("never puts output into the failure reason", async () => {
    const { resolver } = setup(() => ({ code: 1, stdout: "leaky-secret", stderr: "leaky-secret" }));
    const result = await resolver.resolve("rule", { command: ["get"] });

    expect(result).toEqual({ ok: false, reason: "command secret for rule: get exited with 1" });
  });
});

describe("command secret failures", () => {
  it("gives a command 30 s and names a timeout in the reason", async () => {
    const { fake, resolver } = setup(() => ({ code: 124, timedOut: true, stdout: "partial" }));

    expect(await resolver.resolve("rule", { command: ["slow-token"] })).toEqual({
      ok: false,
      reason: "command secret for rule: slow-token timed out after 30 s",
    });
    expect(fake.calls.map((call) => call.options.timeoutMs)).toEqual([30_000]);
  });

  it("kills a hanging command when its time is up", async () => {
    const started = Date.now();
    const outcome = commandSecret({
      key: "rule",
      kind: "command",
      argv: ["sleep", "5"],
      runner: createProcessRunner({ baseEnv: { PATH: process.env.PATH ?? "" } }),
      now: Date.now,
      timeoutMs: 200,
    });

    await expect(outcome).rejects.toThrow("command secret for rule: sleep timed out after 0.2 s");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("runs a failing command again only after 5 s or an invalidate", async () => {
    const { fake, clock, resolver } = setup(() => ({ code: 1 }));

    await resolver.resolve("rule", { command: ["broken"] });

    clock.advance(4_000);

    expect(await resolver.resolve("rule", { command: ["broken"] })).toEqual({
      ok: false,
      reason: "command secret for rule: broken exited with 1",
    });
    expect(fake.calls).toHaveLength(1);

    clock.advance(1_000);

    await resolver.resolve("rule", { command: ["broken"] });

    expect(fake.calls).toHaveLength(2);

    resolver.invalidate("rule");

    await resolver.resolve("rule", { command: ["broken"] });

    expect(fake.calls).toHaveLength(3);
  });
});

describe("piAuth secrets", () => {
  it("asks the host pi for an API key or a bearer token against the host agent dir", async () => {
    const { fake, resolver } = setup(() => ({ stdout: "key\n" }));

    await resolver.resolve("auth:a:key", { piAuth: "provider-a" });

    await resolver.resolve("auth:b:access", { piAuth: "provider-b", bearer: true });

    expect(fake.calls.map(argvOf)).toEqual([
      [...PI, "auth", "print-api-key", "--provider", "provider-a"],
      [...PI, "auth", "print-bearer-token", "--provider", "provider-b", "--min-expiry", "5m"],
    ]);
    expect(fake.calls.map((call) => call.options.env)).toEqual([
      { PI_CODING_AGENT_DIR: join(state.home, ".pi", "agent") },
      { PI_CODING_AGENT_DIR: join(state.home, ".pi", "agent") },
    ]);
  });

  it("reports a failing host pi as a missing or expired login, without its output", async () => {
    const { resolver } = setup(() => ({
      code: 1,
      stdout: "partial",
      stderr: "Error: Failed to resolve credential",
    }));
    const result = await resolver.resolve("auth:a:access", { piAuth: "provider-a", bearer: true });

    expect(result).toEqual({
      ok: false,
      reason: "the provider-a login on the host is missing or expired",
      login: true,
    });
  });

  it("keeps a host pi that could not be started a plain unavailable credential", async () => {
    const { resolver } = setup(() => ({ timedOut: true, code: 1 }));

    expect(await resolver.resolve("auth:a:key", { piAuth: "provider-a" })).toEqual({
      ok: false,
      reason: "piAuth secret for auth:a:key: /usr/bin/node timed out after 30 s",
    });
  });

  it("is unavailable without a pi command", async () => {
    const { resolver } = setup(undefined, { piCommand: [] });

    expect(await resolver.resolve("rule", { piAuth: "a" })).toMatchObject({ ok: false });
  });
});

describe("env and file secrets", () => {
  it("reads env secrets from the map handed over by the launcher, never from the environment", async () => {
    process.env.PI_SANDBOX_TEST_SECRET = "from-daemon-env";

    const { resolver } = setup(undefined, { envSecrets: new Map([["handed", "from-launcher"]]) });

    expect(await secretOf(resolver, "handed", { env: "WHATEVER" })).toBe("from-launcher");
    expect(await resolver.resolve("other", { env: "PI_SANDBOX_TEST_SECRET" })).toMatchObject({ ok: false });

    delete process.env.PI_SANDBOX_TEST_SECRET;
  });

  it("reads a JSON pointer from a file under home", async () => {
    await writeFile(join(state.home, "keys.json"), JSON.stringify({ "a/b": { key: "file-secret" } }));

    const { resolver } = setup();

    expect(await secretOf(resolver, "rule", { file: "~/keys.json", pointer: "/a~1b/key" })).toBe(
      "file-secret",
    );
    expect(await resolver.resolve("rule", { file: "~/keys.json", pointer: "/missing" })).toMatchObject({
      ok: false,
    });
  });

  it("reads a value of a tool config file in its format", async () => {
    const auth = Buffer.from("me:npm-basic").toString("base64");

    await writeFile(join(state.home, ".npmrc"), `//npm.corp.test/:_auth=${auth}\n`);

    await writeFile(
      join(state.home, "pip.conf"),
      "[global]\nindex-url = https://me:pip%3Asecret@pypi.corp.test/\n",
    );

    await writeFile(
      join(state.home, "settings.xml"),
      "<settings><servers><server><id>corp</id><password>m2-secret</password></server></servers></settings>",
    );

    const { resolver } = setup();

    expect(
      await secretOf(resolver, "npm", { file: "~/.npmrc", format: "npmrc", key: "//npm.corp.test/:_auth" }),
    ).toBe("npm-basic");
    expect(
      await secretOf(resolver, "pip", {
        file: "~/pip.conf",
        format: "ini",
        key: "global.index-url",
        urlPassword: true,
      }),
    ).toBe("pip:secret");
    expect(
      await secretOf(resolver, "m2", { file: "~/settings.xml", format: "maven-servers", key: "corp" }),
    ).toBe("m2-secret");
    expect(
      await secretOf(resolver, "m2", { file: "~/settings.xml", format: "maven-servers", key: "other" }),
    ).toContain("has no maven-servers value at other");
  });

  it("hands the launcher only the password of an env URL with urlPassword", () => {
    const rule = { id: "pip", host: "pypi.corp.test", placeholder: "pip", secret: { env: "PIP_INDEX_URL" } };

    expect(
      envSecretsFor([{ ...rule, secret: { env: "PIP_INDEX_URL", urlPassword: true } }], {
        PIP_INDEX_URL: "https://me:p%40ss@pypi.corp.test/simple",
      }),
    ).toEqual({ pip: "p@ss" });
  });

  it("collects env values for the launcher, skipping unset variables and other kinds", () => {
    const envRule = (id: string, secret: SecretRef) => ({ id, host: `${id}.test`, placeholder: id, secret });

    expect(
      envSecretsFor(
        [
          envRule("one", { env: "ONE" }),
          envRule("two", { env: "TWO" }),
          envRule("three", { command: ["x"] }),
        ],
        { ONE: "1", TWO: "" },
      ),
    ).toEqual({ one: "1" });
  });

  it("hands the parent proxy credentials from HTTPS_PROXY", () => {
    expect(parentProxyAuth({ HTTPS_PROXY: "http://corp:p%40ss@proxy.test:3128" })).toBe("corp:p@ss");
    expect(parentProxyAuth({ HTTPS_PROXY: "", https_proxy: "http://corp:pass@proxy.test:3128" })).toBe(
      "corp:pass",
    );
    expect(parentProxyAuth({ HTTPS_PROXY: "socks5://corp:pass@proxy.test:1080" })).toBeUndefined();
  });

  it("refuses an env credential that holds a line break", () => {
    const corp = { id: "corp", host: "corp.test", placeholder: "corp", secret: { env: "CORP" } };

    expect(() => envSecretsFor([corp], { CORP: "abc\r\nX-Evil: 1" })).toThrow(
      "CORP contains a line break and cannot be used as a credential",
    );
  });
});

describe("line breaks in secrets", () => {
  it("trims trailing line breaks from a file secret", async () => {
    const { resolver } = setup();
    const file = join(state.home, "secret.json");

    await writeFile(file, JSON.stringify({ key: "value\r\n" }));

    expect(await secretOf(resolver, "rule", { file, pointer: "/key" })).toBe("value");
  });

  it("refuses an env secret holding a line break", async () => {
    const { resolver } = setup(undefined, { envSecrets: new Map([["rule", "value\n"]]) });

    expect(await secretOf(resolver, "rule", { env: "RULE" })).toContain("line break");
  });
});
