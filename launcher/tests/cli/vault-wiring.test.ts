import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { LABELS } from "../../container/index.ts";
import { isPlaceholder, sha256Hex, stateLayout, writeVaultEntry } from "../../shared/index.ts";
import { expectNoLeak } from "../support/expect-no-leak.ts";
import { createFakeBackend, type FakeExec, stdinOf } from "../support/fake-backend.ts";
import type { FakeCall } from "../support/fake-runner.ts";
import { createHarness, type HarnessOptions, renderDirOf, repoDynamicOf } from "./harness.ts";

const DOCS_URL = "https://mcp.docs.example.test/mcp";

const DOCS_KEY = `mcp__docs|${DOCS_URL}`;

const REAL_ACCESS = "real-access-token-0123456789";

const REAL_REFRESH = "real-refresh-token-0123456789";

const DISCOVERED = {
  ok: true,
  issuer: "https://auth.docs.example.test/",
  authorizationEndpoint: "https://auth.docs.example.test/authorize",
  tokenEndpoint: "https://token.docs.example.test/token",
  hosts: ["auth.docs.example.test", "token.docs.example.test"],
  piState: { authorizationServerUrl: "https://auth.docs.example.test/" },
};

const isDiscovery = (call: FakeCall) =>
  call.file === process.execPath && (call.args[0] ?? "").endsWith("mcp-discover.mjs");

const discovering = (answer: { code?: number; stdout?: string; stderr?: string }) => (call: FakeCall) =>
  isDiscovery(call) ? answer : undefined;

const harnessWith = async (options: HarnessOptions = {}) => {
  const harness = await createHarness(options);

  await harness.writeJson(join(harness.hostAgentDir, "mcp.json"), {
    mcpServers: { docs: { url: DOCS_URL } },
  });

  return harness;
};

const launchWith = async (
  answer: { code?: number; stdout?: string; stderr?: string },
  userConfig?: unknown,
) => {
  const fake = createFakeBackend();
  const harness = await harnessWith({ adapters: () => [fake.backend], respond: discovering(answer) });

  if (userConfig !== undefined) {
    await harness.writeJson(harness.userConfigFile, userConfig);
  }

  expect(await run([], harness.deps)).toBe(0);

  return { fake, harness };
};

const isMcpAuthWrite = (exec: FakeExec) =>
  exec.spec.command.join(" ").includes("pi-sandbox-tmp") &&
  exec.spec.command.some((part) => part.endsWith("/mcp-auth.json"));

const writtenMcpAuth = (execs: FakeExec[]) =>
  execs
    .filter(isMcpAuthWrite)
    .map((exec) => JSON.parse(stdinOf(exec).toString("utf8")) as Record<string, unknown>);

const renderedMcp = (execs: FakeExec[]) => {
  const texts = execs
    .map((exec) => stdinOf(exec).toString("utf8"))
    .filter((text) => text.includes('"mcpServers"'));

  return JSON.parse(texts.at(-1) ?? "{}") as { mcpServers?: Record<string, Record<string, unknown>> };
};

const authorizationOf = (server: Record<string, unknown> | undefined) =>
  String((server?.headers as Record<string, string> | undefined)?.Authorization);

const tokensOf = (written: Record<string, unknown> | undefined) =>
  (written?.[DOCS_KEY] as { tokens?: Record<string, string> } | undefined)?.tokens ?? {};

describe("mcp token vault wiring", () => {
  it("discovers the authorization server at launch on the host and hands its hosts to the proxy", async () => {
    const { fake, harness } = await launchWith({ stdout: JSON.stringify(DISCOVERED) });
    const discovery = harness.calls.find(isDiscovery);
    const dynamic = await repoDynamicOf(harness);
    const docs = renderedMcp(fake.execs).mcpServers?.docs;

    expect(JSON.parse(String(discovery?.options.input))).toEqual({ url: DOCS_URL });
    expect(dynamic?.vault?.map((server) => [server.server, server.discovery.hosts])).toEqual([
      ["docs", DISCOVERED.hosts],
    ]);
    expect(dynamic?.derivedHosts).not.toContain("token.docs.example.test");
    expect(docs?.url).toBe(DOCS_URL);
    expect(docs?.headers).toBeUndefined();
    expect(harness.stderr()).toContain(
      "pi-sandbox: mcp docs: sign in from /mcp in pi, or with pi mcp login docs in the shell\n",
    );
  });

  it("keeps a server whose discovery failed in header mode for the launch and says why", async () => {
    const { fake, harness } = await launchWith({ code: 1, stderr: "no authorization server metadata\n" });
    const dynamic = await repoDynamicOf(harness);
    const docs = renderedMcp(fake.execs).mcpServers?.docs;

    expect(dynamic?.vault).toEqual([]);
    expect(authorizationOf(docs)).toMatch(/^Bearer pi-sandbox-/);
    expect(harness.stderr()).toContain(
      "pi-sandbox: mcp docs: sign-in discovery failed (no authorization server metadata); this launch uses the host sign-in instead\n",
    );
  });

  it("syncs the sandbox mcp-auth.json with placeholders only, never the host tokens", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({
      adapters: () => [fake.backend],
      respond: discovering({ stdout: JSON.stringify(DISCOVERED) }),
    });

    await writeVaultEntry(harness.stateDir, DOCS_KEY, {
      serverUrl: DOCS_URL,
      clientInformation: { client_id: "docs-client" },
      tokens: { access_token: REAL_ACCESS, token_type: "Bearer", refresh_token: REAL_REFRESH },
    });

    expect(await run([], harness.deps)).toBe(0);

    const [written] = writtenMcpAuth(fake.execs);
    const tokens = tokensOf(written);

    expect(isPlaceholder(tokens.access_token ?? "")).toBe(true);
    expect(isPlaceholder(tokens.refresh_token ?? "")).toBe(true);
    expect(harness.stderr()).not.toContain("sign in from /mcp");

    await expectNoLeak(fake, renderDirOf(harness), [REAL_ACCESS, REAL_REFRESH]);
  });

  it("runs the mcp-auth.json sync on every launch, with no entries when no server qualifies", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ adapters: () => [fake.backend] });

    expect(await run([], harness.deps)).toBe(0);
    expect(await run([], harness.deps)).toBe(0);
    expect(writtenMcpAuth(fake.execs)).toEqual([{}, {}]);
    expect(
      JSON.parse(
        await readFile(stateLayout(harness.stateDir).syncMcpAuth(sha256Hex(harness.repoRoot)), "utf8"),
      ),
    ).toEqual({});
  });

  it("turns everything off with credentials.vault.enabled false: no discovery, no vault entries, header mode", async () => {
    const { fake, harness } = await launchWith(
      { stdout: JSON.stringify(DISCOVERED) },
      { credentials: { vault: { enabled: false } } },
    );
    const dynamic = await repoDynamicOf(harness);
    const docs = renderedMcp(fake.execs).mcpServers?.docs;

    expect(harness.calls.some(isDiscovery)).toBe(false);
    expect(dynamic?.vault).toEqual([]);
    expect(authorizationOf(docs)).toMatch(/^Bearer pi-sandbox-/);
    expect(writtenMcpAuth(fake.execs)).toEqual([{}]);
  });
});

describe("intercepted pi mcp login and logout", () => {
  const signIn = async (stateDir: string) => {
    await writeVaultEntry(stateDir, DOCS_KEY, {
      serverUrl: DOCS_URL,
      tokens: { access_token: REAL_ACCESS, token_type: "Bearer" },
    });

    return { code: 0 };
  };

  const signingIn = (stateDir: () => string) => (call: FakeCall) => {
    if (isDiscovery(call)) {
      return { stdout: JSON.stringify(DISCOVERED) };
    }

    return call.interactive && call.args.includes("login") ? signIn(stateDir()) : undefined;
  };

  const loginWith = async (state: "running" | "stopped") => {
    const fake = createFakeBackend();
    const paths = { stateDir: "" };
    const harness = await harnessWith({
      adapters: () => [fake.backend],
      respond: signingIn(() => paths.stateDir),
    });

    paths.stateDir = harness.stateDir;

    fake.addContainer({
      name: "pi-sandbox-repo",
      labels: { [LABELS.repoHash]: sha256Hex(harness.repoRoot) },
      state,
      image: "sha256:image",
    });

    expect(await run(["mcp", "login", "docs"], harness.deps)).toBe(0);

    return { fake, harness };
  };

  it("syncs the new sign-in into the running sandbox as a placeholder", async () => {
    const { fake, harness } = await loginWith("running");
    const [written] = writtenMcpAuth(fake.execs);
    const tokens = tokensOf(written);

    expect(isPlaceholder(tokens.access_token ?? "")).toBe(true);

    await expectNoLeak(fake, renderDirOf(harness), [REAL_ACCESS]);
  });

  it("leaves a stopped sandbox alone, the next launch syncs it", async () => {
    const { fake } = await loginWith("stopped");

    expect(fake.execs).toEqual([]);
  });
});

describe("pi sandbox doctor on the vault", () => {
  const NOW = 1_700_000_000_000;

  const THREE_HOURS = 3 * 3_600_000;

  const doctorLines = async (
    answer: { code?: number; stdout?: string; stderr?: string },
    userConfig?: unknown,
  ) => {
    const fake = createFakeBackend();
    const down = { ...fake.backend, detect: async () => ({ available: false, reason: "socket missing" }) };
    const harness = await harnessWith({ adapters: () => [down], respond: discovering(answer) });

    if (userConfig !== undefined) {
      await harness.writeJson(harness.userConfigFile, userConfig);
    }

    await writeVaultEntry(harness.stateDir, DOCS_KEY, {
      serverUrl: DOCS_URL,
      tokens: { access_token: REAL_ACCESS, token_type: "Bearer" },
      tokensExpireAt: NOW + THREE_HOURS,
    });

    await run(["sandbox", "doctor"], harness.deps);

    return harness.stdout().trim().split("\n");
  };

  it("reports a ready vault server with its authorization server and token lifetime", async () => {
    expect(await doctorLines({ stdout: JSON.stringify(DISCOVERED) })).toContain(
      "ok mcp docs: vault ready (authorization server auth.docs.example.test), signed in, token expires in 3 h",
    );
  });

  it("fails a vault server whose discovery failed", async () => {
    expect(await doctorLines({ code: 1, stderr: "no authorization server metadata\n" })).toContain(
      "fail mcp docs: vault discovery failed: no authorization server metadata",
    );
  });

  it("skips the vault when it is turned off", async () => {
    const lines = await doctorLines(
      { stdout: JSON.stringify(DISCOVERED) },
      { credentials: { vault: { enabled: false } } },
    );

    expect(lines).toContain(
      "skip mcp vault: turned off by credentials.vault.enabled or credentials.derive.enabled",
    );
    expect(lines.some((line) => line.includes("mcp docs"))).toBe(false);
  });
});
