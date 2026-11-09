import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { LABELS, repoVolumes } from "../../container/index.ts";
import { registerLaunch } from "../../grants/index.ts";
import { bootTime, launcherRoot, sha256Hex, stateLayout } from "../../shared/index.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { tempDir } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness } from "./harness.ts";

const packageVersion = async () =>
  (JSON.parse(await readFile(join(launcherRoot(), "..", "package.json"), "utf8")) as { version: string })
    .version;

describe("pi sandbox status", () => {
  it("reports runtime, proxy and image, and no container once the last session exited", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain(`launcher: ${await packageVersion()}`);
    expect(lines).toContain("runtime: colima fake");
    expect(lines).toContain("runtime socket: /fake/docker.sock");
    expect(lines).toContain("container: none");
    expect(lines).toContain("proxy: stopped");
    expect(lines).toContain(`image: ghcr.io/zharskiy/pi-sandbox:${await packageVersion()} sha256:built-1`);
    expect(lines).toContain("launches: 0 running for this repository");
    expect(lines).toContain("grants: 0 active");
  });

  it("reports the running container of this repository", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const id = fake.addContainer({
      name: "pi-sandbox-repo",
      labels: {
        [LABELS.managed]: "true",
        [LABELS.repoHash]: sha256Hex(harness.repoRoot),
        [LABELS.imageDigest]: "sha256:one",
        [LABELS.specHash]: "spec-1",
      },
      state: "running",
      image: "sha256:image-one",
    });

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain(`container: ${id} running`);
    expect(lines).toContain("container digest: sha256:one");
    expect(lines).toContain("container spec hash: spec-1");
  });

  it("reports the proxy of this repository without its token", async () => {
    const harness = await createHarness({
      proxy: { read: async () => ({ pid: 11, port: 4001, boot: 1, inputHash: "input" }) },
    });

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const proxies = harness
      .stdout()
      .split("\n")
      .filter((line) => line.startsWith("proxy: "));

    expect(proxies).toEqual(["proxy: pid 11 port 4001"]);
  });

  it("reports live launches and active grants of this repository", async () => {
    const harness = await createHarness();

    await registerLaunch(harness.stateDir, {
      boot: bootTime(),
      launchId: "0123456789abcdef",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1_700_000_000_000,
    });

    await run(["sandbox", "egress", "allow", "docs.example.test"], harness.deps);

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain("launches: 1 running for this repository");
    expect(lines).toContain(`launch: 0123456789abcdef pid ${process.pid} since 2023-11-14T22:13:20.000Z`);
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
  const orphanOf = async (fake: ReturnType<typeof createFakeBackend>, repoHash: string) => {
    await fake.backend.prepareProxyRoute({ hostPort: 3128, repoHash, imageId: "relay" });

    return fake.addContainer({
      name: `pi-sandbox-${repoHash.slice(0, 12)}`,
      labels: { [LABELS.managed]: "true", [LABELS.repoHash]: repoHash },
      state: "running",
      image: "x",
    });
  };

  it("removes the container, relay and network of a repository no live launch uses", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const orphan = "b".repeat(64);
    const id = await orphanOf(fake, orphan);

    fake.addContainer({ name: "unrelated", labels: {}, state: "running", image: "x" });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(fake.containers.has(id)).toBe(false);
    expect(fake.relays.has(orphan)).toBe(false);
    expect(fake.networks.has(`pi-sandbox-${orphan.slice(0, 12)}`)).toBe(false);
    expect(harness.stoppedProxies).toContain(orphan);
    expect(harness.stdout()).toContain(`removed container pi-sandbox-${orphan.slice(0, 12)} (${id})\n`);
    expect([...fake.containers.values()].map((entry) => entry.summary.name)).toEqual(["unrelated"]);
  });

  it("keeps the proxy, relay and container of a repository whose session is still preparing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const repo = sha256Hex(harness.repoRoot);

    await registerLaunch(harness.stateDir, {
      boot: bootTime(),
      launchId: "00000000000000bb",
      pid: process.pid,
      repoHash: repo,
      startedAt: 1,
    });

    const id = await orphanOf(fake, repo);

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(harness.stoppedProxies).toEqual([]);
    expect(fake.containers.has(id)).toBe(true);
    expect(fake.relays.has(repo)).toBe(true);
  });

  it("forgets a repository whose root no longer exists, with its state and volumes", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const gone = await tempDir("gone-repo");
    const hash = sha256Hex(gone);
    const files = stateLayout(harness.stateDir).repo(hash);

    await harness.writeJson(files.record, { root: gone });

    await fake.backend.ensureVolume("pi-sandbox-agent-gone", { [LABELS.repoHash]: hash });

    await rm(gone, { recursive: true, force: true });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(await readFile(files.record, "utf8").catch(() => undefined)).toBeUndefined();
    expect(fake.volumes.has("pi-sandbox-agent-gone")).toBe(false);
    expect(harness.stdout()).toContain(`forgot ${gone}, which no longer exists\n`);
  });

  it("removes the dangling sandbox images no container uses and keeps the current base, images in use and foreign ones", async () => {
    const fake = createFakeBackend({ localImages: { "foreign:1": "sha256:foreign" } });
    const harness = await createHarness({ backend: () => fake.backend });
    const context = await tempDir("gc-images");
    const build = (tag: string) => fake.backend.buildImage(context, tag);
    const dangling = await build("pi-sandbox-layer:old");
    const used = await build("pi-sandbox-layer:used");
    const current = await build("pi-sandbox:base");

    await build("pi-sandbox-layer:old");

    await build("pi-sandbox-layer:used");

    await build("pi-sandbox:base");

    fake.addContainer({ name: "running", labels: {}, state: "running", image: used.id });

    await harness.writeJson(stateLayout(harness.stateDir).imageRecord, {
      base: { id: current.id, digest: current.digest, inputsHash: "pinned" },
    });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(fake.imageRemovals).toEqual([dangling.id]);
    expect(harness.stdout()).toContain(`removed image ${dangling.id.replace(/^sha256:/, "").slice(0, 12)}\n`);
    expect((await fake.backend.listImages()).map((image) => image.id)).toEqual(
      expect.arrayContaining([used.id, current.id, "sha256:image-foreign"]),
    );
  });

  it("removes a layer tag older than an hour that no record and no container names, and keeps a named one", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const context = await tempDir("gc-layers");

    await fake.backend.buildImage(context, "pi-sandbox-layer:orphan");

    await fake.backend.buildImage(context, "pi-sandbox-layer:named");

    await harness.writeJson(stateLayout(harness.stateDir).repo("d".repeat(64)).image, {
      layer: "pi-sandbox-layer:named",
    });

    fake.ageImages(2 * 60 * 60);

    await fake.backend.buildImage(context, "pi-sandbox-layer:fresh");

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("removed image pi-sandbox-layer:orphan\n");
    expect((await fake.backend.listImages()).flatMap((image) => image.tags).sort()).toEqual([
      "pi-sandbox-layer:fresh",
      "pi-sandbox-layer:named",
    ]);
  });

  it("says when there is nothing to remove", async () => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("nothing to remove\n");
  });

  it("removes this repository's sandbox and proxy on reset, even while it runs", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const repo = sha256Hex(harness.repoRoot);
    const id = await orphanOf(fake, repo);
    const token = stateLayout(harness.stateDir).repo(repo).proxy.token;

    await mkdir(join(token, ".."), { recursive: true });

    await writeFile(token, "f".repeat(64));

    expect(await run(["sandbox", "reset"], harness.deps)).toBe(0);
    expect(fake.containers.has(id)).toBe(false);
    expect(fake.relays.has(repo)).toBe(false);
    expect(harness.stoppedProxies).toEqual([repo]);
    expect(await readFile(token, "utf8").catch(() => undefined)).toBeUndefined();
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

  it("keeps the volumes of a repository that still exists after its container is removed", async () => {
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

  it("keeps a volume without a repository label", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await fake.backend.ensureVolume("pi-sandbox-agent-unlabelled");

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(fake.volumes.has("pi-sandbox-agent-unlabelled")).toBe(true);
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
