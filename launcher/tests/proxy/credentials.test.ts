import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCredentialSource } from "../../proxy/credentials.ts";
import { LauncherError } from "../../shared/index.ts";
import { createFakeRunner, type FakeResponder } from "../support/fake-runner.ts";

const state = { home: "" };

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), "pi-sandbox-credentials-"));
});

afterEach(async () => {
  await rm(state.home, { recursive: true, force: true });
});

const deps = (respond: FakeResponder = () => undefined, extra: Record<string, unknown> = {}) => {
  const fake = createFakeRunner(respond);

  return { fake, deps: { runner: fake.runner, env: {}, home: state.home, ...extra } };
};

const writeAuth = async (value: unknown) => {
  const file = join(state.home, ".pi", "agent", "auth.json");

  await rm(join(state.home, ".pi"), { recursive: true, force: true });

  await mkdir(join(state.home, ".pi", "agent"), { recursive: true });

  await writeFile(file, JSON.stringify(value));
};

describe("static credentials", () => {
  it("reads the configured environment variable", async () => {
    const { deps: options } = deps(undefined, { env: { GATEWAY_TOKEN: "from-env" } });

    await expect(
      createCredentialSource({ kind: "static", envVar: "GATEWAY_TOKEN" }, options).token(),
    ).resolves.toBe("from-env");
  });

  it("reads the macOS keychain through the runner once", async () => {
    const { fake, deps: options } = deps(() => ({ stdout: "from-keychain\n" }), { platform: "darwin" });
    const source = createCredentialSource({ kind: "static", keychainService: "pi-gateway" }, options);

    await expect(source.token()).resolves.toBe("from-keychain");

    await expect(source.token()).resolves.toBe("from-keychain");

    expect(fake.calls.map((call) => [call.file, ...call.args])).toEqual([
      ["security", "find-generic-password", "-s", "pi-gateway", "-w"],
    ]);
  });

  it("refuses the keychain outside macOS and a missing variable", async () => {
    const { deps: linux } = deps(undefined, { platform: "linux" });

    await expect(
      createCredentialSource({ kind: "static", keychainService: "pi-gateway" }, linux).token(),
    ).rejects.toBeInstanceOf(LauncherError);

    await expect(
      createCredentialSource({ kind: "static", envVar: "MISSING" }, linux).token(),
    ).rejects.toThrow("MISSING is not set");
  });
});

describe("host-pi-auth credentials", () => {
  it("takes the configured provider", async () => {
    await writeAuth({
      first: { type: "api_key", key: "first-key" },
      chosen: { type: "oauth", access: "chosen-access", refresh: "r", expires: Date.now() + 60_000 },
    });

    const { deps: options } = deps(undefined, { providers: ["chosen"] });

    await expect(createCredentialSource({ kind: "host-pi-auth" }, options).token()).resolves.toBe(
      "chosen-access",
    );
  });

  it("falls back to the first api_key entry", async () => {
    await writeAuth({
      oauthy: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
      keyed: { type: "api_key", key: "keyed-key" },
    });

    const { deps: options } = deps();

    await expect(createCredentialSource({ kind: "host-pi-auth" }, options).token()).resolves.toBe(
      "keyed-key",
    );
  });

  it("says that an expired OAuth token is not refreshed", async () => {
    await writeAuth({ chosen: { type: "oauth", access: "old", refresh: "r", expires: 1000 } });

    const { deps: options } = deps(undefined, { providers: ["chosen"] });
    const error = (await createCredentialSource({ kind: "host-pi-auth" }, options)
      .token()
      .catch((caught: unknown) => caught)) as LauncherError;

    expect(error).toBeInstanceOf(LauncherError);

    expect(error.hint).toContain("does not refresh");
  });

  it("reads a custom auth file and reports a missing one", async () => {
    const file = join(state.home, "custom-auth.json");

    await writeFile(file, JSON.stringify({ any: { type: "api_key", key: "custom" } }));

    const { deps: options } = deps();

    await expect(
      createCredentialSource({ kind: "host-pi-auth", authFile: file }, options).token(),
    ).resolves.toBe("custom");

    await expect(createCredentialSource({ kind: "host-pi-auth" }, options).token()).rejects.toThrow(
      "not found",
    );
  });

  it("expands ~ in a custom auth file against the home directory", async () => {
    await writeFile(
      join(state.home, "tilde-auth.json"),
      JSON.stringify({ any: { type: "api_key", key: "tilde" } }),
    );

    const { deps: options } = deps();

    await expect(
      createCredentialSource({ kind: "host-pi-auth", authFile: "~/tilde-auth.json" }, options).token(),
    ).resolves.toBe("tilde");
  });
});

describe("sso credentials", () => {
  it("uses a bare token for five minutes", async () => {
    const clock = { now: 1_800_000_000_000 };
    const outputs = ["first\n", "second\n"];
    const { fake, deps: options } = deps(() => ({ stdout: outputs[fake.calls.length - 1] }), {
      now: () => clock.now,
    });
    const source = createCredentialSource({ kind: "sso", command: ["corp-sso", "token"] }, options);

    await expect(source.token()).resolves.toBe("first");

    clock.now += 4 * 60 * 1000;

    await expect(source.token()).resolves.toBe("first");

    clock.now += 2 * 60 * 1000;

    await expect(source.token()).resolves.toBe("second");

    expect(fake.calls[0]).toMatchObject({ file: "corp-sso", args: ["token"] });
  });

  it("honours expiresAt from JSON output", async () => {
    const clock = { now: 1_800_000_000_000 };
    const { fake, deps: options } = deps(
      () => ({ stdout: JSON.stringify({ token: `t${fake.calls.length}`, expiresAt: clock.now + 1000 }) }),
      { now: () => clock.now },
    );
    const source = createCredentialSource({ kind: "sso", command: ["corp-sso"] }, options);

    await expect(source.token()).resolves.toBe("t1");

    clock.now += 2000;

    await expect(source.token()).resolves.toBe("t2");
  });

  it("reports a failing or empty command", async () => {
    const { deps: failing } = deps(() => ({ code: 2, stderr: "session expired\n" }));

    await expect(
      createCredentialSource({ kind: "sso", command: ["corp-sso"] }, failing).token(),
    ).rejects.toThrow("session expired");

    await expect(createCredentialSource({ kind: "sso", command: [] }, failing).token()).rejects.toThrow(
      "credentials.command is empty",
    );
  });
});
