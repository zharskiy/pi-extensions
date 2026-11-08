import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { LABELS, repoVolumes } from "../../container/index.ts";
import { registerSession } from "../../grants/index.ts";
import { launcherRoot, sha256Hex, stateLayout } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { tempDir } from "../support/temp-dir.ts";
import { createHarness } from "./harness.ts";

const packageVersion = async () =>
  (JSON.parse(await readFile(join(launcherRoot(), "..", "package.json"), "utf8")) as { version: string })
    .version;

describe("pi sandbox status", () => {
  it("reports runtime, container, proxy and image", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");
    const [container] = [...fake.containers.values()];

    expect(lines).toContain(`launcher: ${await packageVersion()}`);
    expect(lines).toContain("runtime: colima fake");
    expect(lines).toContain("runtime socket: /fake/docker.sock");
    expect(lines).toContain(`container: ${container?.summary.id} stopped`);
    expect(lines).toContain("container digest: sha256:built-1");
    expect(lines.some((line) => /^container spec hash: [0-9a-f]{64} \(current\)$/.test(line))).toBe(true);
    expect(lines).toContain("proxy: stopped");
    expect(lines).toContain(`image: ghcr.io/zharskiy/pi-sandbox:${await packageVersion()} sha256:built-1`);
    expect(lines).toContain("sessions: 0 running for this repository");
    expect(lines).toContain("grants: 0 active");
  });

  it("reports the container stale when its image digest differs from the recorded image", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];

    Object.assign(container?.summary.labels ?? {}, { [LABELS.imageDigest]: "sha256:older" });

    await run(["sandbox", "status"], harness.deps);

    const lines = harness.stdout().split("\n");

    expect(lines.some((line) => /^container spec hash: [0-9a-f]{64} \(stale\)$/.test(line))).toBe(true);
  });

  it("reports the container stale when its spec hash differs from the one the last launch wanted", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];

    Object.assign(container?.summary.labels ?? {}, { [LABELS.specHash]: "older-spec" });

    await run(["sandbox", "status"], harness.deps);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain("container spec hash: older-spec (stale)");
  });

  it("lists every running proxy instance and marks the one for this repository's policy", async () => {
    const harness = await createHarness({
      proxy: {
        list: async () => [
          { policyHash: "a".repeat(64), pid: 11, port: 4001, token: "secret-token-a" },
          { policyHash: "b".repeat(64), pid: 12, port: 4002, token: "secret-token-b" },
        ],
      },
    });

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const proxies = harness
      .stdout()
      .split("\n")
      .filter((line) => line.startsWith("proxy: "));

    expect(proxies).toEqual([
      `proxy: policy ${"a".repeat(12)} pid 11 port 4001 (other policy)`,
      `proxy: policy ${"b".repeat(12)} pid 12 port 4002 (other policy)`,
    ]);
    expect(harness.stdout()).not.toContain("secret-token");
  });

  it("reports live sessions and active grants of this repository", async () => {
    const harness = await createHarness();

    await registerSession(harness.stateDir, {
      sessionId: "0123456789abcdef",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1_700_000_000_000,
    });

    await run(["sandbox", "egress", "allow", "docs.example.test"], harness.deps);

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain("sessions: 1 running for this repository");
    expect(lines).toContain(`session: 0123456789abcdef pid ${process.pid} since 2023-11-14T22:13:20.000Z`);
    expect(lines).toContain("grants: 1 active");
    expect(lines).toContain("grant: docs.example.test for this repository");
  });

  it("still reports the proxy and image without a reachable engine", async () => {
    const fake = createFakeBackend();
    const down = { ...fake.backend, detect: async () => ({ available: false, reason: "socket missing" }) };
    const harness = await createHarness({ backend: () => down });

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain(
      "runtime: none (the sandbox VM engine is unreachable at ~/.colima/pi-sandbox/docker.sock)",
    );
    expect(harness.stdout()).toContain("proxy: stopped");
    expect(harness.stdout()).toContain("(not built yet)");
  });
});

describe("pi sandbox config", () => {
  it("prints the effective config followed by the source layer of each key", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.userConfigFile, { fallback: "refuse" });

    expect(await run(["sandbox", "config"], harness.deps)).toBe(0);

    const output = harness.stdout();
    const json = output.slice(0, output.indexOf("\n# "));

    expect(JSON.parse(json).fallback).toBe("refuse");
    expect(output).toContain("# fallback: user\n");
    expect(output).toContain("# image.reference: default\n");
  });

  it("prints config and sources as one JSON object with --json", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "config", "--json"], harness.deps)).toBe(0);

    const parsed = JSON.parse(harness.stdout()) as {
      config: { fallback: string };
      sources: Record<string, string>;
    };

    expect(parsed.config.fallback).toBe("host");
    expect(parsed.sources.fallback).toBe("default");
  });

  it("only shows the config and refuses any other option", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "config", "set", "fallback", '"refuse"'], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain('pi-sandbox: unknown config option "set fallback "refuse""\n');
    expect(harness.stderr()).toContain("  hint: pi sandbox config [--json]");
  });
});

describe("pi sandbox gc and reset", () => {
  it("removes stopped launcher containers, this repository's idle one included, and keeps running ones", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    fake.addContainer({
      name: "pi-sandbox-old",
      labels: { [LABELS.managed]: "true" },
      state: "stopped",
      image: "x",
    });

    fake.addContainer({
      name: "pi-sandbox-busy",
      labels: { [LABELS.managed]: "true" },
      state: "running",
      image: "x",
    });

    fake.addContainer({ name: "unrelated", labels: {}, state: "stopped", image: "x" });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("removed 2 stopped containers\n");
    expect([...fake.containers.values()].map((entry) => entry.summary.name).sort()).toEqual([
      "pi-sandbox-busy",
      "unrelated",
    ]);
  });

  it("removes the proxy token of a repository whose container it removed, so the token stops working", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const tokens = stateLayout(harness.stateDir).proxyInstance("policy");
    const other = "b".repeat(64);

    await run([], harness.deps);

    await mkdir(tokens.tokensDir, { recursive: true });

    await writeFile(tokens.repoToken(other), "c".repeat(64));

    fake.addContainer({
      name: "pi-sandbox-other",
      labels: { [LABELS.managed]: "true", [LABELS.repoHash]: other, [LABELS.proxyPolicyHash]: "policy" },
      state: "running",
      image: "x",
    });

    const repoToken = tokens.repoToken(sha256Hex(harness.repoRoot));
    const before = await readFile(repoToken, "utf8").catch(() => undefined);

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(repoToken, "utf8").catch(() => undefined)).toBeUndefined();
    expect(await readFile(tokens.repoToken(other), "utf8")).toBe("c".repeat(64));
  });

  it("removes relays and stops proxies that no running container uses", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
      proxy: {
        list: async () => [
          { policyHash: "policy", pid: 1, port: 3128, token: "t" },
          { policyHash: "idle", pid: 2, port: 4000, token: "t" },
        ],
      },
    });

    await run([], harness.deps);

    fake.addContainer({
      name: "pi-sandbox-busy",
      labels: { [LABELS.managed]: "true", [LABELS.proxyPolicyHash]: "policy" },
      state: "running",
      image: "x",
    });

    const relay = (policyHash: string) =>
      fake.addContainer({
        name: `pi-sandbox-relay-${policyHash}`,
        labels: { [LABELS.managed]: "true", [LABELS.relay]: "true", [LABELS.proxyPolicyHash]: policyHash },
        state: "running",
        image: "relay",
      });
    const kept = relay("policy");
    const idle = relay("idle");

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(fake.containers.has(kept)).toBe(true);
    expect(fake.containers.has(idle)).toBe(false);
    expect(harness.stoppedProxies).toEqual(["idle"]);
    expect(harness.stdout()).toContain("stopped proxy pid 2 port 4000\n");
  });

  it("removes the networks of repositories that have no container left", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const kept = "a".repeat(64);

    await run([], harness.deps);

    fake.addContainer({
      name: "pi-sandbox-kept",
      labels: { [LABELS.managed]: "true", [LABELS.repoHash]: kept },
      state: "running",
      image: "x",
    });

    ["pi-sandbox", `pi-sandbox-${"a".repeat(12)}`, `pi-sandbox-${"b".repeat(12)}`].forEach((name) => {
      fake.networks.add(name);
    });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect([...fake.networks]).toEqual([`pi-sandbox-${"a".repeat(12)}`]);
    expect(harness.stdout()).toContain("removed network pi-sandbox\n");
    expect(harness.stdout()).toContain(`removed network pi-sandbox-${"b".repeat(12)}\n`);
  });

  it("keeps the proxy, relay and container of a repository whose session is still preparing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
      proxy: { list: async () => [{ policyHash: "preparing", pid: 3, port: 5000, token: "t" }] },
    });
    const repo = sha256Hex(harness.repoRoot);
    const tokenFile = stateLayout(harness.stateDir).proxyRepoToken("preparing", repo);

    await mkdir(join(tokenFile, ".."), { recursive: true });

    await writeFile(tokenFile, "f".repeat(64));

    await registerSession(harness.stateDir, {
      sessionId: "00000000000000bb",
      pid: process.pid,
      repoHash: repo,
      startedAt: 1,
    });

    const created = fake.addContainer({
      name: "pi-sandbox-preparing",
      labels: { [LABELS.managed]: "true", [LABELS.repoHash]: repo, [LABELS.proxyPolicyHash]: "preparing" },
      state: "created",
      image: "x",
    });
    const relay = fake.addContainer({
      name: "pi-sandbox-relay-preparing",
      labels: { [LABELS.managed]: "true", [LABELS.relay]: "true", [LABELS.proxyPolicyHash]: "preparing" },
      state: "running",
      image: "relay",
    });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(harness.stoppedProxies).toEqual([]);
    expect(fake.containers.has(created)).toBe(true);
    expect(fake.containers.has(relay)).toBe(true);
  });

  it("removes this repo's container and, with --volumes, its agent and cache volumes", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, { mounts: { cacheVolumes: ["node_modules"] } });

    await run([], harness.deps);

    const [agent = "", cache = ""] = repoVolumes({
      workspace: { cwd: harness.repoRoot, repoRoot: harness.repoRoot, isGitRepo: true },
      config: sandboxConfig({ mounts: { extraReadOnly: [], cacheVolumes: ["node_modules"] } }),
      hostEnv: harness.deps.env,
      uid: harness.deps.uid,
    });

    expect(fake.volumes.has(cache)).toBe(true);
    expect(fake.volumes.has(agent)).toBe(true);
    expect(await run(["sandbox", "reset"], harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.has(cache)).toBe(true);

    await run([], harness.deps);

    expect(await run(["sandbox", "reset", "--volumes"], harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.has(cache)).toBe(false);
    expect(fake.volumes.has(agent)).toBe(false);
    expect(harness.stdout()).toContain(`removed volume ${cache}\n`);
  });

  it("removes a volume whose repository no longer exists on disk", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const gone = await tempDir("gone-repo");

    await fake.backend.ensureVolume("pi-sandbox-agent-gone", {
      [LABELS.repoHash]: sha256Hex(gone),
      [LABELS.repoRoot]: gone,
    });

    await rm(gone, { recursive: true, force: true });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(fake.volumes.has("pi-sandbox-agent-gone")).toBe(false);
    expect(harness.stdout()).toContain("removed volume pi-sandbox-agent-gone\n");
  });

  it("keeps the volumes of a repository that still exists after its stopped container is removed", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [agent = ""] = repoVolumes({
      workspace: { cwd: harness.repoRoot, repoRoot: harness.repoRoot, isGitRepo: true },
      config: sandboxConfig(),
      hostEnv: harness.deps.env,
      uid: harness.deps.uid,
    });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.has(agent)).toBe(true);
    expect(harness.stdout()).not.toContain("removed volume");
  });

  it("keeps a volume without a repository label and says how to remove it", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await fake.backend.ensureVolume("pi-sandbox-agent-unlabelled");

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(fake.volumes.has("pi-sandbox-agent-unlabelled")).toBe(true);
    expect(harness.stdout()).toContain(
      "kept 1 volume without repository label; run pi sandbox reset in the repository or remove them by hand\n",
    );
  });

  it("removes the proxy instance of this repo's policy so its token rotates on the next launch", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    expect(await run(["sandbox", "reset"], harness.deps)).toBe(0);
    expect(harness.removedProxies).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(harness.stdout()).toContain(`removed proxy instance ${harness.removedProxies[0]}\n`);
  });

  it("keeps the proxy instance when a running container of another repository shares its policy", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    await run(["sandbox", "reset"], harness.deps);

    const [policyHash = ""] = harness.removedProxies;

    fake.addContainer({
      name: "pi-sandbox-other",
      labels: { [LABELS.managed]: "true", [LABELS.repoHash]: "other", [LABELS.proxyPolicyHash]: policyHash },
      state: "running",
      image: "x",
    });

    await run([], harness.deps);

    expect(await run(["sandbox", "reset", "--volumes"], harness.deps)).toBe(0);
    expect(harness.removedProxies).toEqual([policyHash]);
    expect(harness.stdout()).toContain(`kept proxy instance ${policyHash}, in use by another repository\n`);
    expect([...fake.containers.values()].map((entry) => entry.summary.name)).toEqual(["pi-sandbox-other"]);
  });
});

describe("pi sandbox help and version", () => {
  it("prints the launcher version from the package manifest", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "--version"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(`${await packageVersion()}\n`);
  });

  it("prints usage for help and for a bare pi sandbox", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "help"], harness.deps)).toBe(0);
    expect(await run(["sandbox"], harness.deps)).toBe(0);
    expect(harness.stdout().match(/pi sandbox doctor/g)).toHaveLength(2);
    expect(harness.stdout()).toContain("pi sandbox gc [--shared-caches]");
  });
});
