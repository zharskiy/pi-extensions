import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LABELS, networkName } from "../../backend/index.ts";
import { releaseSandbox } from "../../cli/commands/uninstall.ts";
import { sha256Hex, stateLayout } from "../../shared/index.ts";
import { FAKE_NETWORK, FAKE_RELAY } from "../support/fake-backend.ts";
import { exists, tempDir } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness, holdLaunch, unreachable } from "./harness.ts";

describe("releaseSandbox", () => {
  it("refuses while a launch is live and removes nothing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const id = fake.addContainer({
      name: "live",
      labels: { [LABELS.managed]: "true", [LABELS.role]: "agent" },
      state: "running",
      image: "x",
    });

    await holdLaunch(harness);

    await expect(releaseSandbox(harness.deps)).rejects.toThrow("1 pi session is running in the sandbox VM");
    expect(fake.containers.has(id)).toBe(true);
  });

  it("removes the managed containers, networks, volumes and images by label, leaves another install's, and releases every folder", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const repo = sha256Hex(harness.repoRoot);
    const context = await tempDir("uninstall-images");

    await fake.backend.prepareRelay({ hostPort: 3128, imageId: "relay", preamble: "PINATA test" });

    const managed = fake.addContainer({
      name: "pinata-a",
      labels: { [LABELS.managed]: "true", [LABELS.role]: "agent", [LABELS.repoHash]: repo },
      state: "running",
      image: "x",
    });
    const foreign = fake.addContainer({ name: "foreign", labels: {}, state: "running", image: "x" });
    const other = fake.backendFor("otherinstall");
    const othersContainer = fake.addContainer({
      name: "pinata-other",
      labels: { [LABELS.managed]: "true", [LABELS.install]: "otherinstall", [LABELS.role]: "agent" },
      state: "stopped",
      image: "x",
    });

    await other.prepareNetwork();

    await other.ensureVolume("pinata-agent-other");

    await fake.backend.ensureVolume("pinata-agent-a", { [LABELS.repoHash]: repo });

    const built = await fake.backend.buildImage(context, "pinata-layer:a");

    await harness.writeJson(stateLayout(harness.stateDir).repo(repo).record, { root: harness.repoRoot });

    await releaseSandbox(harness.deps);
    expect(fake.containers.has(managed)).toBe(false);
    expect(fake.containers.has(foreign)).toBe(true);
    expect(fake.containers.has(othersContainer)).toBe(true);
    expect(fake.relays.size).toBe(0);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(false);
    expect(fake.networks.has(networkName("otherinstall"))).toBe(true);
    expect(fake.volumes.has("pinata-agent-a")).toBe(false);
    expect(fake.volumes.has("pinata-agent-other")).toBe(true);
    expect(fake.imageRemovals).toContain(built.id);
    expect(harness.proxyStops()).toBe(1);
    expect(harness.stdout()).toContain(`install: removed relay ${FAKE_RELAY}\n`);
    expect(harness.stdout()).toContain("host: released the created folders of 1 folder\n");
  });

  it("keeps the sandbox, the ground and the stored objects when a pi session starts while the uninstall runs", async () => {
    const fake = createFakeBackend();
    const detections = { count: 0 };
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        detect: async () => {
          detections.count += 1;

          if (detections.count === 2) {
            await holdLaunch(harness);
          }

          return { available: true };
        },
      }),
    });
    const repo = sha256Hex(harness.repoRoot);

    await fake.backend.prepareRelay({ hostPort: 3128, imageId: "relay", preamble: "PINATA test" });

    const starting = fake.addContainer({
      name: "pinata-starting",
      labels: { [LABELS.managed]: "true", [LABELS.role]: "agent", [LABELS.repoHash]: repo },
      state: "running",
      image: "x",
    });

    await fake.backend.ensureVolume("pinata-agent-a", { [LABELS.repoHash]: repo });

    await expect(releaseSandbox(harness.deps)).rejects.toThrow(
      "the sandbox network, proxy, services, volumes and images were kept",
    );
    expect(fake.containers.has(starting)).toBe(true);
    expect(fake.relays.size).toBe(1);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(true);
    expect(fake.volumes.has("pinata-agent-a")).toBe(true);
    expect(harness.proxyStops()).toBe(0);
    expect(harness.stdout()).toContain(
      `host: a pi session of ${repo.slice(0, 12)} started meanwhile; its sandbox stays\n`,
    );
  });

  it("holds a pi session that registers during the removal of the install objects until the removal ends", async () => {
    const fake = createFakeBackend();
    const order: string[] = [];
    const registering = { done: Promise.resolve() };
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        removeVolume: async (name) => {
          registering.done = holdLaunch(harness).then(() => {
            order.push("registered");
          });

          await new Promise((resolve) => setTimeout(resolve, 100));

          order.push("removed");

          return fake.backend.removeVolume(name);
        },
      }),
    });

    await fake.backend.ensureVolume("pinata-cache-a");

    await releaseSandbox(harness.deps);

    await registering.done;

    expect(order).toEqual(["removed", "registered"]);
    expect(fake.volumes.has("pinata-cache-a")).toBe(false);
  });

  it("releases the host side and leaves the engine objects to the profile when the VM is stopped", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });
    const repo = "c".repeat(64);
    const mountPoint = join(harness.root, "elsewhere", "node_modules");

    await mkdir(mountPoint, { recursive: true });

    await harness.writeJson(stateLayout(harness.stateDir).repo(repo).created, [mountPoint]);

    await releaseSandbox(harness.deps);
    expect(await exists(mountPoint)).toBe(false);
    expect(harness.proxyStops()).toBe(1);
    expect(harness.stdout()).toContain(
      "engine: the sandbox VM is not running, its objects go with the colima profile\n",
    );
  });

  it("stops the proxy when listing the engine's containers fails", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        findContainers: () => Promise.reject(new Error("engine broke")),
      }),
    });

    await expect(releaseSandbox(harness.deps)).rejects.toThrow("engine broke");
    expect(harness.proxyStops()).toBe(1);
  });
});
