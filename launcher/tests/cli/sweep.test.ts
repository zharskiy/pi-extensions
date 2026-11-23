import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Backend, ContainerSpec, ContainerState } from "../../backend/index.ts";
import { LABELS, networkName } from "../../backend/index.ts";
import { sweepOrphans } from "../../cli/sweep.ts";
import { liveLaunches, newLaunchId, readGrants, registerLaunch } from "../../grants/index.ts";
import {
  processMark,
  readCreatedDirs,
  repoRecordOf,
  sha256Hex,
  stateLayout,
  writeRepoRecord,
} from "../../shared/index.ts";
import { FAKE_INSTALL } from "../support/fake-backend.ts";
import { tempDir } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness, sweepNow } from "./harness.ts";

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const DEAD_PID = 2 ** 22 + 4321;

const leftRepo = async (harness: Awaited<ReturnType<typeof createHarness>>, name: string) => {
  const root = join(await realpath(await tempDir(name)), "repo");
  const hash = sha256Hex(root);
  const files = stateLayout(harness.stateDir).repo(hash);
  const mountPoint = join(root, "node_modules");

  await mkdir(mountPoint, { recursive: true });

  await harness.writeJson(files.record, { root });

  await harness.writeJson(files.created, [mountPoint]);

  return { root, hash, files, mountPoint };
};

describe("the sweep of a repository no launch uses", () => {
  it("removes the mount points it created, and says so when the engine side fails", async () => {
    const fake = createFakeBackend();
    const backend: Backend = {
      ...fake.backend,
      findContainers: async (labels) => {
        if (labels[LABELS.repoHash] !== undefined) {
          throw new Error("engine busy");
        }

        return fake.backend.findContainers(labels);
      },
    };
    const harness = await createHarness({ backend: () => backend });
    const left = await leftRepo(harness, "failed-engine");

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(harness.stderr()).toContain("the sandbox containers were not removed: engine busy");
    expect(await exists(left.mountPoint)).toBe(false);
    expect(await readCreatedDirs(harness.stateDir, left.hash)).toEqual([]);
  });
});

describe("the sweep of what is left in the state dir", () => {
  it("keeps a repository under a mount point that is not mounted, though its empty folder is there", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const mountRoot = join(await realpath(await tempDir("volumes")), "share");
    const root = join(mountRoot, "repo");
    const hash = sha256Hex(root);
    const files = stateLayout(harness.stateDir).repo(hash);

    await mkdir(mountRoot);

    await harness.writeJson(files.record, { root, mountRoot });

    await fake.backend.ensureVolume("pi-sandbox-agent-volume-root", {
      [LABELS.repoHash]: hash,
      [LABELS.repoRoot]: root,
    });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(await repoRecordOf(harness.stateDir, hash)).toEqual({ root, mountRoot });
    expect(fake.volumes.has("pi-sandbox-agent-volume-root")).toBe(true);
  });

  it("forgets a repository whose folder is gone at the sweep, with its grants, and leaves its volumes to the collection", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const root = join(await realpath(await tempDir("gone")), "repo");
    const hash = sha256Hex(root);
    const layout = stateLayout(harness.stateDir);

    await harness.writeJson(layout.repo(hash).record, { root });

    await harness.writeJson(layout.gcRecord, { lastRun: harness.deps.now() });

    await harness.writeJson(layout.grants, [
      { host: "gone.test", port: 443, repoHash: hash, createdAt: 1 },
      { host: "kept.test", port: 443, createdAt: 1 },
    ]);

    await fake.backend.ensureVolume("pi-sandbox-agent-gone", {
      [LABELS.repoHash]: hash,
      [LABELS.repoRoot]: root,
    });

    expect(await sweepOrphans(harness.deps, fake.backend)).toEqual([
      `forgot ${root}, which no longer exists`,
    ]);
    expect(await exists(layout.repo(hash).directory)).toBe(false);
    expect((await readGrants(harness.stateDir)).map((grant) => grant.host)).toEqual(["kept.test"]);
    expect(fake.volumes.has("pi-sandbox-agent-gone")).toBe(true);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.volumes.has("pi-sandbox-agent-gone")).toBe(false);
  });

  it("keeps a repository whose root cannot be checked for another reason than it is missing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const locked = await realpath(await tempDir("locked"));
    const root = join(locked, "inner", "repo");
    const hash = sha256Hex(root);
    const files = stateLayout(harness.stateDir).repo(hash);

    await mkdir(root, { recursive: true });

    await harness.writeJson(files.record, { root });

    await chmod(join(locked, "inner"), 0o600);

    try {
      expect(await sweepNow(harness.deps)).toBe(0);
      expect(await repoRecordOf(harness.stateDir, hash)).toEqual({ root });
    } finally {
      await chmod(join(locked, "inner"), 0o700);
    }
  });

  it("records the mount point a repository root lies on", async () => {
    const harness = await createHarness();
    const hash = sha256Hex("/dev");

    await writeRepoRecord(harness.stateDir, hash, "/dev");

    expect(await repoRecordOf(harness.stateDir, hash)).toEqual({ root: "/dev", mountRoot: "/dev" });
    expect(
      JSON.parse(await readFile(stateLayout(harness.stateDir).repo(sha256Hex("/dev")).record, "utf8")),
    ).toEqual({ root: "/dev", mountRoot: "/dev" });
  });

  it("removes the entry a killed launcher left", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const hash = sha256Hex(harness.repoRoot);
    const entry = join(stateLayout(harness.stateDir).launches, `${newLaunchId()}.json`);

    await harness.writeJson(stateLayout(harness.stateDir).repo(hash).record, { root: harness.repoRoot });

    await harness.writeJson(entry, {
      launchId: "0".repeat(16),
      pid: DEAD_PID,
      boot: 1,
      start: "never",
      repoHash: hash,
      startedAt: 1,
    });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(await exists(entry)).toBe(false);
    expect(await liveLaunches(harness.stateDir)).toEqual([]);
  });

  it("removes the container of an ended launch while another launch of the repository runs", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const hash = sha256Hex(harness.repoRoot);
    const live = { launchId: newLaunchId(), repoHash: hash, startedAt: 1, ...(await processMark()) };
    const container = (launchId?: string) =>
      fake.addContainer({
        name: `pi-sandbox-repo-${launchId ?? "none"}`,
        labels: {
          [LABELS.managed]: "true",
          [LABELS.role]: "agent",
          [LABELS.repoHash]: hash,
          ...(launchId === undefined ? {} : { [LABELS.launchId]: launchId }),
        },
        state: "running",
        image: "x",
      });

    await harness.writeJson(stateLayout(harness.stateDir).repo(hash).record, { root: harness.repoRoot });

    await registerLaunch(harness.stateDir, live);

    const kept = container(live.launchId);
    const ended = container(newLaunchId());
    const unlabelled = container();

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.containers.has(kept)).toBe(true);
    expect(fake.containers.has(ended)).toBe(false);
    expect(fake.containers.has(unlabelled)).toBe(false);
  });

  it("never takes a pod or a service of a running repository for an ended launch", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const hash = sha256Hex(harness.repoRoot);
    const live = { launchId: newLaunchId(), repoHash: hash, startedAt: 1, ...(await processMark()) };
    const companion = (role: string) =>
      fake.addContainer({
        name: `pi-sandbox-repo-${role}`,
        labels: {
          [LABELS.managed]: "true",
          [LABELS.repoHash]: hash,
          [LABELS.role]: role,
          [LABELS.launchId]: newLaunchId(),
        },
        state: "running",
        image: "x",
      });

    await harness.writeJson(stateLayout(harness.stateDir).repo(hash).record, { root: harness.repoRoot });

    await registerLaunch(harness.stateDir, live);

    const pod = companion("pod");
    const service = companion("service");

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.containers.has(pod)).toBe(true);
    expect(fake.containers.has(service)).toBe(true);
  });

  it("removes a repository's session, pod and relay, the session with a short stop", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const orphan = "e".repeat(64);
    const repo = { [LABELS.managed]: "true", [LABELS.repoHash]: orphan };
    const agent = fake.addContainer({
      name: "agent",
      labels: { ...repo, [LABELS.role]: "agent" },
      state: "running",
      image: "x",
    });
    const pod = fake.addContainer({
      name: "pod",
      labels: { ...repo, [LABELS.role]: "pod" },
      state: "running",
      image: "pod",
    });

    await fake.backend.prepareRelay({ hostPort: 3128, imageId: "relay", preamble: "PI-SANDBOX test" });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.stops).toContainEqual({ id: agent, timeoutSeconds: 3 });
    expect(fake.containers.size).toBe(0);
    expect(harness.stdout()).toContain(`removed container agent (${agent})`);
    expect(harness.stdout()).toContain(`removed container pod (${pod})`);
    expect(harness.stdout()).toContain("removed relay ");
  });

  it("forgets a repository it knows only from engine labels once its sandbox is removed", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const orphan = "d".repeat(64);
    const id = fake.addContainer({
      name: `pi-sandbox-${orphan.slice(0, 12)}`,
      labels: { [LABELS.managed]: "true", [LABELS.role]: "agent", [LABELS.repoHash]: orphan },
      state: "running",
      image: "x",
    });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.containers.has(id)).toBe(false);
    expect(await exists(stateLayout(harness.stateDir).repo(orphan).directory)).toBe(false);
  });
});

describe("the daily collection of older builds' engine objects", () => {
  const MANAGED = { [LABELS.managed]: "true" };

  const OTHER = { [LABELS.managed]: "true", [LABELS.install]: "otherinstall" };

  const plantContainer = (
    fake: ReturnType<typeof createFakeBackend>,
    name: string,
    state: ContainerState,
    labels: Record<string, string>,
    attachments: { volume?: string; network?: string } = {},
  ) => {
    const mounts =
      attachments.volume === undefined
        ? []
        : [{ kind: "volume" as const, source: attachments.volume, target: "/data", readOnly: false }];
    const network =
      attachments.network === undefined ? { kind: "none" } : { kind: "internal", name: attachments.network };
    const spec = { mounts, network } as unknown as ContainerSpec;

    fake.containers.set(name, { spec, summary: { id: name, name, labels, state, image: "old" } });
  };

  const plantVolume = (
    fake: ReturnType<typeof createFakeBackend>,
    name: string,
    labels: Record<string, string>,
  ) => {
    fake.volumes.add(name);

    fake.volumeLabels.set(name, labels);
  };

  it("removes a stopped container, its volume and a free network of an older build, and says so", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    plantContainer(fake, "pi-sandbox-old-stopped", "stopped", MANAGED, { volume: "pi-sandbox-agent-held" });

    plantVolume(fake, "pi-sandbox-agent-held", MANAGED);

    fake.plantForeignNetwork("pi-sandbox-network-old", MANAGED);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.containers.has("pi-sandbox-old-stopped")).toBe(false);
    expect(fake.volumes.has("pi-sandbox-agent-held")).toBe(false);
    expect(fake.hasNetwork("pi-sandbox-network-old")).toBe(false);
    expect(harness.stdout()).toContain("removed container pi-sandbox-old-stopped\n");
    expect(harness.stdout()).toContain("removed volume pi-sandbox-agent-held\n");
    expect(harness.stdout()).toContain("removed network pi-sandbox-network-old\n");
  });

  it("keeps an older build's volume that a container it keeps still mounts, without a word", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const current = { [LABELS.managed]: "true", [LABELS.install]: FAKE_INSTALL };

    plantContainer(fake, "pi-sandbox-current", "stopped", current, { volume: "pi-sandbox-agent-reused" });

    plantVolume(fake, "pi-sandbox-agent-reused", MANAGED);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.volumes.has("pi-sandbox-agent-reused")).toBe(true);
    expect(harness.stdout()).not.toContain("removed");
    expect(harness.stderr()).toBe("");
  });

  it("keeps a running container of an older build with its volume and network", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    plantContainer(fake, "pi-sandbox-old-running", "running", MANAGED, {
      volume: "pi-sandbox-agent-busy",
      network: "pi-sandbox-network-busy",
    });

    plantVolume(fake, "pi-sandbox-agent-busy", MANAGED);

    fake.plantForeignNetwork("pi-sandbox-network-busy", MANAGED);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.containers.has("pi-sandbox-old-running")).toBe(true);
    expect(fake.volumes.has("pi-sandbox-agent-busy")).toBe(true);
    expect(fake.hasNetwork("pi-sandbox-network-busy")).toBe(true);
  });

  it("keeps another install's objects, unmanaged pi-sandbox objects and older builds' shared volumes", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    plantVolume(fake, "pi-sandbox-agent-other", OTHER);

    plantContainer(fake, "pi-sandbox-other", "stopped", OTHER);

    await fake.backendFor("otherinstall").prepareNetwork();

    plantVolume(fake, "pi-sandbox-scratch", {});

    plantContainer(fake, "pi-sandbox-mine", "stopped", {});

    fake.plantForeignNetwork("pi-sandbox-net", {});

    plantVolume(fake, "pi-sandbox-shared-oldinstall00-aaaaaaaa", MANAGED);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.volumes.has("pi-sandbox-agent-other")).toBe(true);
    expect(fake.containers.has("pi-sandbox-other")).toBe(true);
    expect(fake.hasNetwork(networkName("otherinstall"))).toBe(true);
    expect(fake.volumes.has("pi-sandbox-scratch")).toBe(true);
    expect(fake.containers.has("pi-sandbox-mine")).toBe(true);
    expect(fake.hasNetwork("pi-sandbox-net")).toBe(true);
    expect(fake.volumes.has("pi-sandbox-shared-oldinstall00-aaaaaaaa")).toBe(true);
    expect(harness.stdout()).not.toContain("removed");
  });
});
