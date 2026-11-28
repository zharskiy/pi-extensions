import { describe, expect, it } from "vitest";
import { LABELS } from "../../backend/index.ts";
import { releaseSandbox } from "../../cli/pinata/uninstall.ts";
import { sha256Hex, stateLayout, withFileLock } from "../../shared/index.ts";
import { createFakeBackend, createHarness, holdLaunch, unreachable } from "./harness.ts";

const tracked = () => {
  const runs = { count: 0 };

  const teardown = async () => {
    runs.count += 1;
  };

  return { runs, teardown };
};

const otherSession = (fake: ReturnType<typeof createFakeBackend>) =>
  fake.addContainer({
    name: "pinata-other",
    labels: { [LABELS.managed]: "true", [LABELS.install]: "otherinstall", [LABELS.role]: "agent" },
    state: "running",
    image: "x",
  });

describe("releaseSandbox", () => {
  it("releases every folder, stops the proxy and tears down, leaving the engine objects to the VM delete", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const { runs, teardown } = tracked();
    const repo = "c".repeat(64);
    const container = fake.addContainer({
      name: "pinata-a",
      labels: { [LABELS.managed]: "true", [LABELS.role]: "agent", [LABELS.repoHash]: repo },
      state: "stopped",
      image: "x",
    });

    await releaseSandbox(harness.deps, () => undefined, teardown);
    expect(harness.proxyStops()).toBe(1);
    expect(runs.count).toBe(1);
    expect(fake.containers.has(container)).toBe(true);
    expect(harness.stdout()).toBe("");
  });

  it("tears down when the VM is stopped", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });
    const { runs, teardown } = tracked();

    await releaseSandbox(harness.deps, () => undefined, teardown);
    expect(runs.count).toBe(1);
    expect(harness.proxyStops()).toBe(1);
  });

  it("keeps the sandbox when a pi session starts while it runs", async () => {
    const fake = createFakeBackend();
    const detections = { count: 0 };
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        detect: async () => {
          detections.count += 1;

          if (detections.count === 1) {
            otherSession(fake);
          }

          return { available: true };
        },
      }),
    });
    const { runs, teardown } = tracked();
    const repo = sha256Hex(harness.repoRoot);
    const notes: string[] = [];

    await harness.writeJson(stateLayout(harness.stateDir).repo(repo).record, { root: harness.repoRoot });

    const release = withFileLock(stateLayout(harness.stateDir).repo(repo).prepareLock, () =>
      releaseSandbox(harness.deps, (line) => notes.push(line), teardown),
    );

    await expect(release).rejects.toThrow(
      "a pi session started in the sandbox VM meanwhile (1 pi session is running",
    );
    expect(runs.count).toBe(0);
    expect(harness.proxyStops()).toBe(0);
    expect(notes).toEqual([`A pi session of ${repo.slice(0, 12)} started meanwhile; its sandbox stays`]);
  });

  it("holds a pi session that registers during the teardown until the teardown ends", async () => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend });
    const order: string[] = [];
    const registering = { done: Promise.resolve() };

    const teardown = async () => {
      registering.done = holdLaunch(harness).then(() => {
        order.push("registered");
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      order.push("removed");
    };

    await releaseSandbox(harness.deps, () => undefined, teardown);

    await registering.done;

    expect(order).toEqual(["removed", "registered"]);
  });

  it("does not tear down when stopping the proxy fails", async () => {
    const harness = await createHarness({
      backend: () => createFakeBackend().backend,
      proxy: { stop: () => Promise.reject(new Error("proxy would not stop")) },
    });
    const { runs, teardown } = tracked();

    await expect(releaseSandbox(harness.deps, () => undefined, teardown)).rejects.toThrow(
      "proxy would not stop",
    );
    expect(runs.count).toBe(0);
  });
});
