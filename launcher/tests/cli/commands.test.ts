import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { LABELS, repoVolumes } from "../../container/index.ts";
import { registerSession } from "../../grants/index.ts";
import { launcherRoot, sha256Hex, stateLayout } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
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

const packageVersion = async () =>
  (JSON.parse(await readFile(join(launcherRoot(), "..", "package.json"), "utf8")) as { version: string })
    .version;

describe("pi sandbox status", () => {
  it("reports backend, container, proxy, image and capability gaps", async () => {
    const fake = createFakeBackend({ capabilities: { sshAgent: false, internalNetwork: false } });
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await run([], harness.deps);

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");
    const [container] = [...fake.containers.values()];

    expect(lines).toContain(`launcher: ${await packageVersion()}`);
    expect(lines).toContain("backend: colima fake");
    expect(lines).toContain("backend socket: /fake/docker.sock");
    expect(lines).toContain(`container: ${container?.summary.id} stopped`);
    expect(lines).toContain("container digest: sha256:built-1");
    expect(lines.some((line) => /^container config hash: [0-9a-f]{64} \(current\)$/.test(line))).toBe(true);
    expect(lines).toContain("proxy: stopped");
    expect(lines).toContain(`image: ghcr.io/zharskiy/pi-sandbox:${await packageVersion()} sha256:built-1`);
    expect(lines).toContain("gap: no ssh agent forwarding, ssh.agent has no effect");
    expect(lines).toContain("gap: no internal network, the container cannot reach the egress proxy");
    expect(lines).toContain("sessions: 0 running for this repository");
    expect(lines).toContain("grants: 0 active");
  });

  it("reports the container stale when its image digest differs from the recorded image", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];

    Object.assign(container?.summary.labels ?? {}, { [LABELS.imageDigest]: "sha256:older" });

    await run(["sandbox", "status"], harness.deps);

    const lines = harness.stdout().split("\n");

    expect(lines.some((line) => /^container config hash: [0-9a-f]{64} \(stale\)$/.test(line))).toBe(true);
  });

  it("reports the container stale when its spec hash differs from the one the last launch wanted", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];

    Object.assign(container?.summary.labels ?? {}, { [LABELS.specHash]: "older-spec" });

    await run(["sandbox", "status"], harness.deps);

    const lines = harness.stdout().split("\n");

    expect(lines.some((line) => /^container config hash: [0-9a-f]{64} \(stale\)$/.test(line))).toBe(true);
  });

  it("lists every running proxy instance and marks the one for this repository's policy", async () => {
    const harness = await harnessWith({
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
    const harness = await harnessWith();

    await registerSession(harness.stateDir, {
      launchId: "0123456789abcdef",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1_700_000_000_000,
    });

    await run(["sandbox", "egress", "allow", "docs.example.test", "--permanent"], harness.deps);

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain("sessions: 1 running for this repository");
    expect(lines).toContain(`session: 0123456789abcdef pid ${process.pid} since 2023-11-14T22:13:20.000Z`);
    expect(lines).toContain("grants: 1 active");
    expect(lines).toContain("grant: docs.example.test for this repository permanently");
  });

  it("still reports the proxy and image without a backend", async () => {
    const fake = createFakeBackend();
    const down = { ...fake.backend, detect: async () => ({ available: false, reason: "socket missing" }) };
    const harness = await harnessWith({ adapters: () => [down] });

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain(
      "backend: none (no sandbox backend available: colima (socket missing); apple (no adapter on this host))",
    );
    expect(harness.stdout()).toContain("proxy: stopped");
    expect(harness.stdout()).toContain("(not built yet)");
  });
});

describe("pi sandbox config", () => {
  it("prints the effective config followed by the source layer of each key", async () => {
    const harness = await harnessWith();

    await harness.writeJson(harness.userConfigFile, { backend: "colima" });

    expect(await run(["sandbox", "config"], harness.deps)).toBe(0);

    const output = harness.stdout();
    const json = output.slice(0, output.indexOf("\n# "));

    expect(JSON.parse(json).backend).toBe("colima");
    expect(output).toContain("# backend: user\n");
    expect(output).toContain("# fallback: default\n");
  });

  it("prints config and sources as one JSON object with --json", async () => {
    const harness = await harnessWith();

    expect(await run(["sandbox", "config", "--json"], harness.deps)).toBe(0);

    const parsed = JSON.parse(harness.stdout()) as {
      config: { backend: string };
      sources: Record<string, string>;
    };

    expect(parsed.config.backend).toBe("auto");
    expect(parsed.sources.backend).toBe("default");
  });

  it("sets a user key, or a project key with --project", async () => {
    const harness = await harnessWith();

    expect(await run(["sandbox", "config", "set", "backend", '"apple"'], harness.deps)).toBe(0);
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual({ backend: "apple" });
    expect(harness.stdout()).toContain(`set backend in ${harness.userConfigFile}`);

    expect(
      await run(
        ["sandbox", "config", "set", "mounts.cacheVolumes", '["node_modules"]', "--project"],
        harness.deps,
      ),
    ).toBe(0);

    const projectFile = join(harness.repoRoot, ".pi", "sandbox.json");

    expect(JSON.parse(await readFile(projectFile, "utf8"))).toEqual({
      mounts: { cacheVolumes: ["node_modules"] },
    });
    expect(await readFile(join(harness.repoRoot, ".pi", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("refuses a value that is not JSON with a hint", async () => {
    const harness = await harnessWith();

    expect(await run(["sandbox", "config", "set", "backend", "apple"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("pi-sandbox: config set backend: apple is not a JSON value\n");
    expect(harness.stderr()).toContain(
      `  hint: quote strings as JSON, for example pi sandbox config set backend '"apple"'`,
    );
  });

  it("refuses loosening a key the org baseline locked, and writes nothing", async () => {
    const harness = await harnessWith();
    const baseline = join(harness.root, "org-baseline.json");

    await harness.writeJson(baseline, { egress: { grants: { permanent: false } } });

    await harness.writeJson(harness.userConfigFile, { org: { source: baseline } });

    expect(await run(["sandbox", "config", "set", "egress.grants.permanent", "true"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("locked by org");
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual({ org: { source: baseline } });
  });

  it("refuses loosening a key the policy locked and names the layer", async () => {
    const harness = await harnessWith();

    await harness.writeJson(harness.policyFile, { fallback: "refuse" });

    expect(await run(["sandbox", "config", "set", "fallback", '"host"'], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("policy");
  });
});

describe("pi sandbox gc and reset", () => {
  it("removes stopped launcher containers, this repository's idle one included, and keeps running ones", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

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
    expect(harness.stdout()).toContain("pruned 0 ended grants\n");
    expect([...fake.containers.values()].map((entry) => entry.summary.name).sort()).toEqual([
      "pi-sandbox-busy",
      "unrelated",
    ]);
  });

  it("removes relays and stops proxies that no running container uses", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({
      adapters: () => [fake.backend],
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
    const harness = await harnessWith({ adapters: () => [fake.backend] });
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
    const harness = await harnessWith({
      adapters: () => [fake.backend],
      proxy: { list: async () => [{ policyHash: "preparing", pid: 3, port: 5000, token: "t" }] },
    });
    const repo = sha256Hex(harness.repoRoot);
    const tokenFile = stateLayout(harness.stateDir).proxyRepoToken("preparing", repo);

    await mkdir(join(tokenFile, ".."), { recursive: true });

    await writeFile(tokenFile, "f".repeat(64));

    await registerSession(harness.stateDir, {
      launchId: "00000000000000bb",
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
    const harness = await harnessWith({ adapters: () => [fake.backend] });

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

  it("removes the proxy instance of this repo's policy so its token rotates on the next launch", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await run([], harness.deps);

    expect(await run(["sandbox", "reset"], harness.deps)).toBe(0);
    expect(harness.removedProxies).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(harness.stdout()).toContain(`removed proxy instance ${harness.removedProxies[0]}\n`);
  });

  it("keeps the proxy instance when a running container of another repository shares its policy", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

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
    const harness = await harnessWith();

    expect(await run(["sandbox", "--version"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(`${await packageVersion()}\n`);
  });

  it("prints usage for help and for a bare pi sandbox", async () => {
    const harness = await harnessWith();

    expect(await run(["sandbox", "help"], harness.deps)).toBe(0);
    expect(await run(["sandbox"], harness.deps)).toBe(0);
    expect(harness.stdout().match(/pi sandbox doctor/g)).toHaveLength(2);
  });
});
