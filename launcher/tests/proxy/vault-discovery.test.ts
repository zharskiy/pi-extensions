import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiscovery } from "../../proxy/vault/discovery.ts";
import { stateLayout } from "../../shared/index.ts";
import { createFakeClock } from "../support/fake-clock.ts";
import { argvOf, createFakeRunner, type FakeResponder } from "../support/fake-runner.ts";
import { createStateDir, removeDir } from "./harness.ts";
import { vaultServer } from "./vault-fixture.ts";

const COMMAND = ["/usr/bin/node", "/opt/pi/mcp-discover.mjs"];

const DISCOVERED = {
  ok: true,
  issuer: "https://login.test",
  authorizationEndpoint: "https://login.test/authorize",
  tokenEndpoint: "https://login.test/token",
  hosts: ["login.test"],
  piState: {},
};

const state = { stateDir: "" };

beforeEach(async () => {
  state.stateDir = await createStateDir();
});

afterEach(async () => {
  await removeDir(state.stateDir);
});

const setup = (respond: FakeResponder, command: string[] | undefined = COMMAND) => {
  const fake = createFakeRunner(respond);
  const clock = createFakeClock();
  const discover = createDiscovery({
    stateDir: state.stateDir,
    runner: fake.runner,
    command,
    now: clock.now,
  });

  return { fake, clock, discover };
};

const cachePath = () => stateLayout(state.stateDir).mcpAuthDiscovery("docs");

describe("vault discovery", () => {
  it("runs the discover command with the server URL when no cache exists and caches the result with mode 600", async () => {
    const { fake, clock, discover } = setup(() => ({ stdout: JSON.stringify(DISCOVERED) }));
    const server = vaultServer({ oauth: { authServerMetadataUrl: "https://login.test/meta" } });
    const found = await discover(server);

    expect(found).toMatchObject({ ...DISCOVERED, server: "docs", url: server.url, fetchedAt: clock.now() });
    expect(fake.calls.map(argvOf)).toEqual([COMMAND]);
    expect(JSON.parse(fake.calls[0]?.options.input ?? "")).toEqual({
      url: server.url,
      authServerMetadataUrl: "https://login.test/meta",
    });
    expect((await stat(cachePath())).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(cachePath(), "utf8"))).toMatchObject({
      ok: true,
      tokenEndpoint: DISCOVERED.tokenEndpoint,
    });
  });

  it("uses a successful cache whatever its age", async () => {
    const { fake, clock, discover } = setup(() => ({ stdout: JSON.stringify(DISCOVERED) }));

    await discover(vaultServer());

    clock.advance(30 * 24 * 3_600_000);

    await discover(vaultServer());

    expect(fake.calls).toHaveLength(1);
  });

  it("caches a failure for 60 s and then tries again", async () => {
    const { fake, clock, discover } = setup(() => ({ code: 1, stderr: "trace\nmetadata unreachable\n" }));
    const first = await discover(vaultServer());

    clock.advance(59_000);

    await discover(vaultServer());

    expect(fake.calls).toHaveLength(1);

    clock.advance(2_000);

    await discover(vaultServer());

    expect(first).toEqual({
      ok: false,
      server: "docs",
      url: vaultServer().url,
      error: "metadata unreachable",
      fetchedAt: expect.any(Number),
    });
    expect(fake.calls).toHaveLength(2);
  });

  it("runs one discovery for concurrent callers", async () => {
    const { fake, discover } = setup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));

      return { stdout: JSON.stringify(DISCOVERED) };
    });

    await Promise.all([discover(vaultServer()), discover(vaultServer())]);

    expect(fake.calls).toHaveLength(1);
  });

  it("falls back to the launch-time record without a command", async () => {
    const { discover } = setup(() => undefined, []);

    expect(await discover(vaultServer())).toEqual(vaultServer().discovery);
  });

  it("ignores a cache written for another URL", async () => {
    await mkdir(dirname(cachePath()), { recursive: true });

    await writeFile(
      cachePath(),
      JSON.stringify({ ...DISCOVERED, server: "docs", url: "https://old.test/mcp", fetchedAt: 1 }),
    );

    const { fake, discover } = setup(() => ({ stdout: JSON.stringify(DISCOVERED) }));

    await discover(vaultServer());

    expect(fake.calls).toHaveLength(1);
  });

  it("records unexpected output as a failure", async () => {
    const { discover } = setup(() => ({ stdout: "not json" }));

    expect(await discover(vaultServer())).toMatchObject({ ok: false, error: "unexpected output" });
  });
});
