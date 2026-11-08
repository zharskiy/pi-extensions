import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecretRef } from "../../config/index.ts";
import {
  createSecretResolver,
  envSecretsFor,
  PARENT_PROXY_SECRET_KEY,
  type SecretResolverDeps,
} from "../../proxy/secrets/index.ts";
import { createFakeClock } from "../support/fake-clock.ts";
import { argvOf, createFakeRunner, type FakeResponder } from "../support/fake-runner.ts";

const PI = ["/usr/bin/node", "/opt/pi/cli.js"];

const state = { home: "", mcpAuthDir: "" };

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), "pi-sandbox-secrets-"));
  state.mcpAuthDir = join(state.home, "state", "mcp-auth");

  await mkdir(join(state.mcpAuthDir, "servers"), { recursive: true });
});

afterEach(async () => {
  await rm(state.home, { recursive: true, force: true });
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
    envSecrets: async () => new Map(),
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

  it("honours ttlSeconds and the expiry of JSON output", async () => {
    const { fake, clock, resolver } = setup((call) =>
      call.file === "json-token"
        ? {
            stdout: JSON.stringify({ token: "jwt", expiresAt: new Date(clock.now() + 10_000).toISOString() }),
          }
        : { stdout: "short" },
    );

    expect(await secretOf(resolver, "json", { command: ["json-token"] })).toBe("jwt");

    await resolver.resolve("short", { command: ["short-token"], ttlSeconds: 5 });

    clock.advance(6_000);

    await resolver.resolve("json", { command: ["json-token"] });

    await resolver.resolve("short", { command: ["short-token"], ttlSeconds: 5 });

    clock.advance(5_000);

    await resolver.resolve("json", { command: ["json-token"] });

    expect(fake.calls.map((call) => call.file)).toEqual([
      "json-token",
      "short-token",
      "short-token",
      "json-token",
    ]);
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

describe("rules sharing an id", () => {
  it("keeps separate cache entries for different references under one id", async () => {
    const { resolver } = setup((call) => ({ stdout: call.args[0] ?? "" }));

    expect(await secretOf(resolver, "derived:x", { command: ["echo", "first"] })).toBe("first");
    expect(await secretOf(resolver, "derived:x", { command: ["echo", "second"] })).toBe("second");
    expect(await secretOf(resolver, "derived:x", { command: ["echo", "first"] })).toBe("first");
  });
});

describe("piAuth secrets", () => {
  it("asks the bundled pi for an API key or a bearer token", async () => {
    const { fake, resolver } = setup(() => ({ stdout: "key\n" }));

    await resolver.resolve("auth:a:key", { piAuth: "provider-a" });

    await resolver.resolve("auth:b:access", { piAuth: "provider-b", bearer: true });

    expect(fake.calls.map(argvOf)).toEqual([
      [...PI, "auth", "print-api-key", "--provider", "provider-a"],
      [...PI, "auth", "print-bearer-token", "--provider", "provider-b", "--min-expiry", "5m"],
    ]);
  });

  it("is unavailable without a pi command", async () => {
    const { resolver } = setup(undefined, { piCommand: [] });

    expect(await resolver.resolve("rule", { piAuth: "a" })).toMatchObject({ ok: false });
  });
});

describe("env and file secrets", () => {
  it("reads env secrets from the map handed over by the launcher, never from the environment", async () => {
    process.env.PI_SANDBOX_TEST_SECRET = "from-daemon-env";

    const { resolver } = setup(undefined, { envSecrets: async () => new Map([["handed", "from-launcher"]]) });

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

  it("collects env values for the launcher, skipping unset variables and other kinds", () => {
    const envRule = (id: string, secret: SecretRef) => ({ id, host: `${id}.test`, placeholder: id, secret });

    expect(
      envSecretsFor(
        [
          envRule("one", { env: "ONE" }),
          envRule("two", { env: "TWO" }),
          envRule("three", { command: ["x"] }),
        ],
        "none",
        { ONE: "1", TWO: "" },
      ),
    ).toEqual({ one: "1" });
  });

  it("hands the parent proxy credentials from HTTPS_PROXY", () => {
    expect(envSecretsFor([], "env", { HTTPS_PROXY: "http://corp:p%40ss@proxy.test:3128" })).toEqual({
      [PARENT_PROXY_SECRET_KEY]: "corp:p@ss",
    });
    expect(envSecretsFor([], "none", { HTTPS_PROXY: "http://corp:pass@proxy.test:3128" })).toEqual({});
  });

  it("refuses an env credential that holds a line break", () => {
    const corp = { id: "corp", host: "corp.test", placeholder: "corp", secret: { env: "CORP" } };

    expect(() => envSecretsFor([corp], "none", { CORP: "abc\r\nX-Evil: 1" })).toThrow(
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
    const { resolver } = setup(undefined, { envSecrets: async () => new Map([["rule", "value\n"]]) });

    expect(await secretOf(resolver, "rule", { env: "RULE" })).toContain("line break");
  });

  it("looks env secrets up for the requesting repository", async () => {
    const asked: Array<string | undefined> = [];
    const { resolver } = setup(undefined, {
      envSecrets: async (repoHash) => {
        asked.push(repoHash);

        return new Map([["rule", `for-${repoHash}`]]);
      },
    });

    expect((await resolver.resolve("rule", { env: "RULE" }, "repo-a")).ok).toBe(true);
    expect(asked).toEqual(["repo-a"]);
  });
});

describe("mcpOAuth secrets", () => {
  const URL_TEXT = "https://mcp.example.test/mcp";

  const ref = { mcpOAuth: { server: "docs-server", url: URL_TEXT } };

  const key = `mcp__docs_server|${new URL(URL_TEXT).href}`;

  const writeStore = (access: string, tokensExpireAt: number) =>
    writeFile(
      join(state.mcpAuthDir, "mcp-auth.json"),
      JSON.stringify({
        [key]: { tokens: { access_token: access, refresh_token: "r" }, tokensExpireAt },
        "mcp__other|https://other.test/": { tokens: { access_token: "other" } },
      }),
    );

  const writeServer = () =>
    writeFile(
      join(state.mcpAuthDir, "servers", "docs-server.json"),
      JSON.stringify({ url: URL_TEXT, oauth: { clientRegistration: "auto" }, headers: { leak: "x" } }),
    );

  const refresher =
    (clock: { now(): number }, seen: unknown[]) => async (call: Parameters<FakeResponder>[0]) => {
      const agentDir = call.options.env?.PI_CODING_AGENT_DIR ?? "";
      const copied = JSON.parse(await readFile(join(agentDir, "mcp-auth.json"), "utf8"));

      seen.push(JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8")));

      seen.push(Object.keys(copied));

      await writeFile(
        join(agentDir, "mcp-auth.json"),
        JSON.stringify({
          [key]: { tokens: { access_token: "fresh-token" }, tokensExpireAt: clock.now() + 3_600_000 },
        }),
      );

      return { stdout: "" };
    };

  it("uses a valid stored token without running pi", async () => {
    const { fake, clock, resolver } = setup();

    await writeStore("stored-token", clock.now() + 3_600_000);

    expect(await secretOf(resolver, "mcp:docs-server:oauth", ref)).toBe("stored-token");
    expect(fake.calls).toHaveLength(0);
  });

  it("refreshes a token within 30 s of expiry through a one-server agent dir", async () => {
    const seen: unknown[] = [];
    const clock = createFakeClock();
    const { fake, resolver } = setup((call) => refresher(clock, seen)(call), { now: clock.now });

    await writeServer();

    await writeStore("old-token", clock.now() + 20_000);

    expect(await secretOf(resolver, "mcp:docs-server:oauth", ref)).toBe("fresh-token");
    expect(fake.calls.map(argvOf)).toEqual([[...PI, "mcp", "list"]]);
    expect(fake.calls[0]?.options.env?.PI_CODING_AGENT_DIR).not.toBe(state.mcpAuthDir);
    expect(fake.calls[0]?.options.cwd).not.toBe(state.mcpAuthDir);
    expect(seen).toEqual([
      { mcpServers: { "docs-server": { url: URL_TEXT, oauth: { clientRegistration: "auto" } } } },
      [key],
    ]);
    expect(JSON.parse(await readFile(join(state.mcpAuthDir, "mcp-auth.json"), "utf8"))[key].tokens).toEqual({
      access_token: "fresh-token",
    });
  });

  it("injects a token with a 60 s lifetime and keeps it after a refresh that changed nothing", async () => {
    const clock = createFakeClock();
    const { fake, resolver } = setup(() => ({ stdout: "" }), { now: clock.now });

    await writeServer();

    await writeStore("short-token", clock.now() + 60_000);

    expect(await secretOf(resolver, "rule", ref)).toBe("short-token");
    expect(fake.calls).toHaveLength(0);

    clock.advance(31_000);

    expect(await secretOf(resolver, "rule", ref)).toBe("short-token");
    expect(await secretOf(resolver, "rule", ref)).toBe("short-token");
    expect(fake.calls).toHaveLength(1);
  });

  it("injects a token with 45 s remaining without running pi on every request", async () => {
    const clock = createFakeClock();
    const { fake, resolver } = setup(() => ({ stdout: "" }), { now: clock.now });

    await writeServer();

    await writeStore("live-token", clock.now() + 45_000);

    const values = await Promise.all([1, 2, 3].map(() => secretOf(resolver, "rule", ref)));

    clock.advance(10_000);

    values.push(await secretOf(resolver, "rule", ref));

    expect(values).toEqual(["live-token", "live-token", "live-token", "live-token"]);
    expect(fake.calls).toHaveLength(0);

    clock.advance(6_000);

    await secretOf(resolver, "rule", ref);

    clock.advance(5_000);

    await secretOf(resolver, "rule", ref);

    expect(fake.calls).toHaveLength(1);
  });

  it("rejects an expired token whose refresh did nothing", async () => {
    const clock = createFakeClock();
    const { fake, resolver } = setup(() => undefined, { now: clock.now });

    await writeServer();

    await writeStore("expired-token", clock.now() - 1);

    expect(await secretOf(resolver, "rule", ref)).toBe(
      `unavailable: mcpOAuth secret for rule: no valid token for docs-server; run pi mcp login docs-server`,
    );
    expect(fake.calls).toHaveLength(2);
  });

  it("tries the host refresh once more when the first run left the expired token in place", async () => {
    const seen: unknown[] = [];
    const clock = createFakeClock();
    const attempts = { count: 0 };
    const { fake, resolver } = setup(
      async (call) => {
        attempts.count += 1;

        return attempts.count === 1 ? { stdout: "" } : refresher(clock, seen)(call);
      },
      { now: clock.now },
    );

    await writeServer();

    await writeStore("expired-token", clock.now() - 1);

    expect(await secretOf(resolver, "rule", ref)).toBe("fresh-token");
    expect(fake.calls).toHaveLength(2);
  });

  it("picks up a token pi rotated during the refresh", async () => {
    const seen: unknown[] = [];
    const clock = createFakeClock();
    const { fake, resolver } = setup((call) => refresher(clock, seen)(call), { now: clock.now });

    await writeServer();

    await writeStore("old-token", clock.now() + 45_000);

    expect(await secretOf(resolver, "rule", ref)).toBe("old-token");

    clock.advance(20_000);

    expect(await secretOf(resolver, "rule", ref)).toBe("fresh-token");

    clock.advance(60_000);

    expect(await secretOf(resolver, "rule", ref)).toBe("fresh-token");
    expect(fake.calls).toHaveLength(1);
  });

  it("refreshes once after a 401 even when the token has not expired", async () => {
    const seen: unknown[] = [];
    const clock = createFakeClock();
    const { fake, resolver } = setup((call) => refresher(clock, seen)(call), { now: clock.now });

    await writeServer();

    await writeStore("revoked-token", clock.now() + 3_600_000);

    expect(await secretOf(resolver, "rule", ref)).toBe("revoked-token");

    resolver.invalidate("rule");

    expect(await secretOf(resolver, "rule", ref)).toBe("fresh-token");
    expect(await secretOf(resolver, "rule", ref)).toBe("fresh-token");
    expect(fake.calls).toHaveLength(1);
  });

  it("is unavailable without a stored sign-in, and never names a token", async () => {
    const { clock, resolver } = setup();

    await writeStore("expired-token-value", clock.now() - 1);

    const result = await resolver.resolve("rule", ref);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("expired-token-value");
  });

  describe("locking", () => {
    const delayedRefresher = (clock: { now(): number }) => async (call: Parameters<FakeResponder>[0]) => {
      await new Promise((resolve) => setTimeout(resolve, 50));

      return refresher(clock, [])(call);
    };

    it("lets two resolvers sharing one store run pi mcp list once", async () => {
      const clock = createFakeClock();
      const fake = createFakeRunner(delayedRefresher(clock));
      const deps = { runner: fake.runner, now: clock.now };
      const first = setup(undefined, deps);
      const second = setup(undefined, deps);

      await writeServer();

      await writeStore("old-token", clock.now() - 1);

      const values = await Promise.all([
        secretOf(first.resolver, "rule", ref),
        secretOf(second.resolver, "rule", ref),
      ]);

      expect(values).toEqual(["fresh-token", "fresh-token"]);
      expect(fake.calls).toHaveLength(1);
    });

    it("waits for a held store lock before copying a refresh back", async () => {
      const clock = createFakeClock();
      const { resolver } = setup((call) => refresher(clock, [])(call), { now: clock.now });
      const lock = join(state.mcpAuthDir, "mcp-auth.json.lock");

      await writeServer();

      await writeStore("old-token", clock.now() - 1);

      await mkdir(lock);

      const pending = secretOf(resolver, "rule", ref);

      await new Promise((resolve) => setTimeout(resolve, 300));

      const during = JSON.parse(await readFile(join(state.mcpAuthDir, "mcp-auth.json"), "utf8"))[key].tokens;

      await rm(lock, { recursive: true });

      expect(during.access_token).toBe("old-token");
      expect(await pending).toBe("fresh-token");
    });

    it("takes over a stale refresh lock", async () => {
      const clock = createFakeClock();
      const { fake, resolver } = setup((call) => refresher(clock, [])(call), { now: clock.now });
      const lock = join(state.mcpAuthDir, "refresh-docs-server.lock");
      const old = new Date(Date.now() - 60_000);

      await writeServer();

      await writeStore("old-token", clock.now() - 1);

      await mkdir(lock);

      await utimes(lock, old, old);

      expect(await secretOf(resolver, "rule", ref)).toBe("fresh-token");
      expect(fake.calls).toHaveLength(1);
    });

    it("skips the copy-back when another writer changed the access token meanwhile", async () => {
      const clock = createFakeClock();
      const { resolver } = setup(
        async (call) => {
          await writeStore("rotated-elsewhere", clock.now() + 3_600_000);

          return refresher(clock, [])(call);
        },
        { now: clock.now },
      );

      await writeServer();

      await writeStore("old-token", clock.now() - 1);

      expect(await secretOf(resolver, "rule", ref)).toBe("rotated-elsewhere");
    });
  });
});
