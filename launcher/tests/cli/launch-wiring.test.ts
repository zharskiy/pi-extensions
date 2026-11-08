import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProxyRouteRequest } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { type DenialRecord, PARENT_PROXY_SECRET_KEY } from "../../proxy/index.ts";
import { sha256Hex } from "../../shared/index.ts";
import { expectNoLeak } from "../support/expect-no-leak.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createHarness, renderDirOf, repoDynamicOf, repoTokenOf } from "./harness.ts";

const REAL_KEY = "real-secret-value-1234567890";

const PINNED = `sha256:${"a".repeat(64)}`;

const denial = (host: string, port: number): DenialRecord => ({
  time: 1_700_000_000_500,
  host,
  port,
  repoHash: "repo",
  rule: "egress.allow",
  reason: "not allowed",
});

describe("pi launch wiring", () => {
  it("gives the container its repository token, never the instance token, and records it for the proxy", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];
    const url = new URL(container?.spec?.env.HTTPS_PROXY ?? "");

    expect(url.password).toMatch(/^[0-9a-f]{64}$/);
    expect(url.password).not.toBe("token-1");
    expect(await repoTokenOf(harness)).toBe(url.password);
    expect(await repoDynamicOf(harness)).toEqual({ rules: [], derivedHosts: expect.any(Array), vault: [] });
  });

  it("hands env secrets to the proxy, not to the container", async () => {
    const fake = createFakeBackend({ registry: { "registry.example.test/pi-sandbox:1": PINNED } });
    const harness = await createHarness({
      backend: () => fake.backend,
      env: { CORP_TOKEN: REAL_KEY },
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
      image: { reference: "registry.example.test/pi-sandbox:1", digest: PINNED },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.controlMessages).toEqual([
      {
        type: "env-secrets",
        repoTokenHash: sha256Hex(await repoTokenOf(harness)),
        secrets: { corp: REAL_KEY },
      },
    ]);

    await expectNoLeak(fake, renderDirOf(harness), [REAL_KEY]);
  });

  it("hands the env parent proxy's credentials over control and starts the proxy without them", async () => {
    const fake = createFakeBackend({ registry: { "registry.example.test/pi-sandbox:1": PINNED } });
    const requests: Array<{ env: NodeJS.ProcessEnv }> = [];
    const harness = await createHarness({
      backend: () => fake.backend,
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
      {
        type: "env-secrets",
        repoTokenHash: sha256Hex(await repoTokenOf(harness)),
        secrets: { [PARENT_PROXY_SECRET_KEY]: "corp:p@ss" },
      },
    ]);
    expect(requests.map((request) => request.env.HTTPS_PROXY)).toEqual(["http://proxy.example.test:8080"]);

    await expectNoLeak(fake, renderDirOf(harness), ["p@ss", "p%40ss"]);

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.controlMessages).toHaveLength(2);
  });

  it("renders host auth.json with placeholders into a read-only render mount", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(join(harness.hostAgentDir, "auth.json"), {
      example: { type: "api_key", key: REAL_KEY },
    });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];
    const renderDir = renderDirOf(harness);
    const rendered = await readFile(join(renderDir, "auth.json"), "utf8");

    expect(container?.spec?.mounts).toContainEqual({
      source: renderDir,
      target: "/opt/pi-sandbox/render",
      readOnly: true,
      kind: "bind",
    });
    expect(JSON.parse(rendered).example.key).toMatch(/^pi-sandbox-[0-9a-f]{24}$/);

    await expectNoLeak(fake, renderDir, [REAL_KEY]);
  });

  it("says when a credential rule host resolves to a private address", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
      resolve: async () => ["10.0.0.7"],
    });

    await harness.writeJson(join(harness.hostAgentDir, "auth.json"), {
      example: { type: "api_key", key: REAL_KEY },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain(
      "pi-sandbox: models.example.test resolves to a private address; add it to egress.privateHosts",
    );
  });

  it("launches without the private address notice when DNS does not answer within 2 s", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
      resolve: () => new Promise<string[]>(() => undefined),
    });

    await harness.writeJson(join(harness.hostAgentDir, "auth.json"), {
      example: { type: "api_key", key: REAL_KEY },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).not.toContain("resolves to a private address");
  });

  it("prints one line per denied host when pi exits", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
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

  it("points at egress.allow instead of a grant when egress grants are off", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
      denials: [denial("evil.test", 443)],
    });

    await harness.writeJson(harness.policyFile, { egress: { grants: false } });

    await run([], harness.deps);

    expect(harness.stderr()).toContain(
      "pi-sandbox: evil.test was blocked; egress grants are off, add it to egress.allow\n",
    );
    expect(harness.stderr()).not.toContain("egress allow evil.test");
  });

  it("says once that the host CA store was skipped when the launcher does not run on macOS", async () => {
    const fake = createFakeBackend();
    const linux = await createHarness({ backend: () => fake.backend });
    const mac = await createHarness({ backend: () => createFakeBackend().backend });
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
    const harness = await createHarness({ backend: () => fake.backend, bundledPi: null });

    await harness.writeJson(join(harness.hostAgentDir, "mcp.json"), {
      mcpServers: { docs: { url: "https://docs.example.test/mcp" } },
    });

    await run([], harness.deps);

    expect(harness.stderr()).toContain("pi-sandbox: mcp docs: sign in with pi mcp login docs\n");
    expect(harness.stderr()).toContain(
      "pi-sandbox: no pi on the host, built-in providers get no credential rules; install pi or reinstall the launcher with npm install -g pi-extensions-mz\n",
    );
  });
});

describe("the proxy route of a repository", () => {
  it("asks the backend for the repository's own network", async () => {
    const fake = createFakeBackend();
    const asked: Array<string | undefined> = [];
    const backend = {
      ...fake.backend,
      prepareProxyRoute: (request: ProxyRouteRequest) => {
        asked.push(request.repoHash);

        return fake.backend.prepareProxyRoute(request);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(asked).toEqual([sha256Hex(harness.repoRoot)]);
  });

  it("prints the notices of the proxy route", async () => {
    const fake = createFakeBackend({ routeNotices: ["the relay is kept"] });
    const harness = await createHarness({ backend: () => fake.backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain("pi-sandbox: the relay is kept\n");
  });
});
