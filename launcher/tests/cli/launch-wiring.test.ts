import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { readGrants, registerSession } from "../../grants/index.ts";
import { type DenialRecord, PARENT_PROXY_SECRET_KEY } from "../../proxy/index.ts";
import { sha256Hex, stateLayout } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createHarness } from "./harness.ts";

const harnesses: Array<{ cleanup(): Promise<void> }> = [];

const harnessWith = async (options: Parameters<typeof createHarness>[0] = {}) => {
  const harness = await createHarness(options);

  harnesses.push(harness);

  return harness;
};

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

const REAL_KEY = "real-secret-value-1234567890";

const PINNED = `sha256:${"a".repeat(64)}`;

const denial = (host: string, port: number): DenialRecord => ({
  time: 1_700_000_000_500,
  host,
  port,
  repoHash: "repo",
  rule: "allowlist",
  reason: "not allowed",
});

describe("pi launch wiring", () => {
  it("gives the container its repository token, never the instance token, and records it for the proxy", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];
    const url = new URL(container?.spec?.env.HTTPS_PROXY ?? "");
    const repoHash = sha256Hex(harness.repoRoot);
    const dynamic = JSON.parse(
      await readFile(stateLayout(harness.stateDir).proxyDynamic("policy"), "utf8"),
    ) as { tokens: Record<string, string> };

    expect(url.password).toMatch(/^[0-9a-f]{64}$/);
    expect(url.password).not.toBe("token-1");
    expect(await readFile(stateLayout(harness.stateDir).proxyRepoToken("policy", repoHash), "utf8")).toBe(
      url.password,
    );
    expect(dynamic.tokens[sha256Hex(url.password)]).toBe(repoHash);
  });

  it("hands env secrets and the parent proxy credentials to the proxy, not to the container", async () => {
    const fake = createFakeBackend({ registry: { "registry.example.test/pi-sandbox:1": PINNED } });
    const harness = await harnessWith({
      adapters: () => [fake.backend],
      env: { CORP_TOKEN: REAL_KEY, PARENT_CREDS: "user:password-123" },
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
      egress: { parentProxy: { url: "http://proxy.example.test:8080", auth: { env: "PARENT_CREDS" } } },
      image: { reference: "registry.example.test/pi-sandbox:1", digest: PINNED },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.controlMessages).toEqual([
      { type: "env-secrets", secrets: { corp: REAL_KEY, [PARENT_PROXY_SECRET_KEY]: "user:password-123" } },
    ]);

    const [container] = [...fake.containers.values()];

    expect(JSON.stringify(container?.spec)).not.toContain(REAL_KEY);
  });

  it("hands the env parent proxy's credentials over control and starts the proxy without them", async () => {
    const fake = createFakeBackend({ registry: { "registry.example.test/pi-sandbox:1": PINNED } });
    const requests: Array<{ env: NodeJS.ProcessEnv }> = [];
    const harness = await harnessWith({
      adapters: () => [fake.backend],
      env: { HTTPS_PROXY: "http://corp:p%40ss@proxy.example.test:8080" },
      proxy: {
        ensure: async (request) => {
          requests.push(request);

          return { pid: 4242, port: 3128, policyHash: "policy", token: "token-1" };
        },
      },
    });

    await harness.writeJson(harness.userConfigFile, {
      image: { reference: "registry.example.test/pi-sandbox:1", digest: PINNED },
    });

    expect(await run([], harness.deps)).toBe(0);

    expect(harness.controlMessages).toEqual([
      { type: "env-secrets", secrets: { [PARENT_PROXY_SECRET_KEY]: "corp:p@ss" } },
    ]);
    expect(requests.map((request) => request.env.HTTPS_PROXY)).toEqual(["http://proxy.example.test:8080"]);

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.controlMessages).toHaveLength(2);
  });

  it("renders host auth.json with placeholders into a read-only render mount", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await harness.writeJson(join(harness.hostAgentDir, "auth.json"), {
      example: { type: "api_key", key: REAL_KEY },
    });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];
    const renderDir = stateLayout(harness.stateDir).render(sha256Hex(harness.repoRoot));
    const rendered = await readFile(join(renderDir, "auth.json"), "utf8");

    expect(container?.spec?.mounts).toContainEqual({
      source: renderDir,
      target: "/opt/pi-sandbox/render",
      readOnly: true,
      kind: "bind",
    });
    expect(rendered).not.toContain(REAL_KEY);
    expect(JSON.parse(rendered).example.key).toMatch(/^pi-sandbox-[0-9a-f]{24}$/);
  });

  it("prints one line per denied host when pi exits", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({
      adapters: () => [fake.backend],
      denials: [
        denial("blocked.example.test", 443),
        denial("blocked.example.test", 443),
        denial("other.test", 8443),
      ],
    });

    await run([], harness.deps);

    expect(harness.stderr()).toContain(
      "pi-sandbox: blocked.example.test was blocked; run pi sandbox egress allow blocked.example.test\n",
    );
    expect(harness.stderr()).toContain(
      "pi-sandbox: other.test:8443 was blocked; run pi sandbox egress allow other.test:8443\n",
    );
    expect(harness.stderr().match(/blocked\.example\.test was blocked/g)).toHaveLength(1);
  });

  it("stops the container when the last session of the repository ends", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];

    expect(container?.summary.state).toBe("stopped");
    expect(fake.stops.map((stop) => stop.id)).toEqual([container?.summary.id]);
  });

  it("keeps the container running while another session of the repository is live", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await registerSession(harness.stateDir, {
      launchId: "0123456789abcdef",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
    });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];

    expect(container?.summary.state).toBe("running");
    expect(fake.stops).toEqual([]);
  });

  it("drops session grants of ended launches when the container is created", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await harness.writeJson(stateLayout(harness.stateDir).grants, [
      { host: "gone.example.test", port: 443, createdAt: 1, launchId: "ffffffffffffffff", expiresAt: 9e15 },
      { host: "kept.example.test", port: 443, createdAt: 1 },
    ]);

    await run([], harness.deps);

    expect((await readGrants(harness.stateDir)).map((grant) => grant.host)).toEqual(["kept.example.test"]);
  });

  it("says once that the host CA store was skipped when the launcher does not run on macOS", async () => {
    const fake = createFakeBackend();
    const linux = await harnessWith({ adapters: () => [fake.backend] });
    const mac = await harnessWith({ adapters: () => [createFakeBackend().backend] });
    const notice =
      "pi-sandbox: tls.extraCa hostStore reads the macOS System keychain only and was skipped here";

    linux.deps.platform = "linux";

    await linux.writeJson(linux.userConfigFile, { tls: { extraCa: [{ hostStore: true }] } });

    await mac.writeJson(mac.userConfigFile, { tls: { extraCa: [{ hostStore: true }] } });

    expect(await run([], linux.deps)).toBe(0);
    expect(await run([], mac.deps)).toBe(0);
    expect(linux.stderr().split(notice)).toHaveLength(2);
    expect(mac.stderr()).not.toContain(notice);
  });

  it("prints derivation notices on stderr, one line each", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend], bundledPi: null });

    await harness.writeJson(join(harness.hostAgentDir, "mcp.json"), {
      mcpServers: { docs: { url: "https://docs.example.test/mcp" } },
    });

    await run([], harness.deps);

    expect(harness.stderr()).toContain("pi-sandbox: mcp docs: sign in with pi mcp login docs\n");
    expect(harness.stderr()).toContain("pi-sandbox: the launcher's bundled pi is missing");
  });
});
