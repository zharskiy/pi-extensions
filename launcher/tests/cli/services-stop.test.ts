import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LABELS } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { configVolumeName } from "../../container/index.ts";
import { newLaunchId, registerLaunch } from "../../grants/index.ts";
import { proxyToken } from "../../proxy/index.ts";
import { processMark, sha256Hex, stateLayout } from "../../shared/index.ts";
import { FAKE_NETWORK } from "../support/fake-backend.ts";
import { createFakeBackend, createHarness, sweepNow } from "./harness.ts";

type Fake = ReturnType<typeof createFakeBackend>;

const plantServices = (fake: Fake) => {
  const container = (role: string, name: string, extra: Record<string, string>) =>
    fake.addContainer({
      name,
      labels: { [LABELS.managed]: "true", [LABELS.role]: role, ...extra },
      state: "running",
      image: "x",
    });
  const pod = container("pod", "pi-sandbox-pod", {});
  const first = container("service", "pi-sandbox-service-db", { [LABELS.serviceName]: "db" });
  const second = container("service", "pi-sandbox-service-cache", { [LABELS.serviceName]: "cache" });

  return { pod, first, second };
};

const gracefulStops = (fake: Fake) =>
  fake.stops
    .filter((stop) => stop.timeoutSeconds === 30)
    .map((stop) => stop.id)
    .sort();

const registerSession = async (stateDir: string, repoHash: string) => {
  await registerLaunch(stateDir, {
    launchId: newLaunchId(),
    repoHash,
    startedAt: 1,
    ...(await processMark()),
  });
};

const SERVICES = [
  { name: "db", command: ["db"], volumes: [{ name: "db-data", target: "/data" }] },
  { name: "cache", command: ["cache"] },
];

describe("stopping the services", () => {
  it("stops the idle services, then removes the pod, when the sweep runs", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const { pod, first, second } = plantServices(fake);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(gracefulStops(fake)).toEqual([first, second].sort());
    expect(fake.removals.slice(2, 3)).toEqual([pod]);
    expect(harness.stdout()).toContain(`(${pod})`);
  });

  it("keeps the services under the sweep while a session of another repository runs", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const { pod } = plantServices(fake);

    await registerSession(harness.stateDir, "e".repeat(64));

    await sweepNow(harness.deps);

    expect(gracefulStops(fake)).toEqual([]);
    expect(fake.containers.has(pod)).toBe(true);
  });

  it("leaves the services to pi sandbox reset of a repository", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const hash = sha256Hex(harness.repoRoot);
    const { pod } = plantServices(fake);

    await harness.writeJson(stateLayout(harness.stateDir).repo(hash).record, { root: harness.repoRoot });

    await registerSession(harness.stateDir, "e".repeat(64));

    expect(await run(["sandbox", "reset"], harness.deps)).toBe(0);
    expect(gracefulStops(fake)).toEqual([]);
    expect(fake.containers.has(pod)).toBe(true);
  });

  it("removes the services and the service volumes under reset --services, and leaves the network to the ground teardown", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const { pod, first, second } = plantServices(fake);
    const data = configVolumeName(harness.stateDir, "db-data");

    await harness.writeJson(harness.userConfigFile, { services: SERVICES });

    await fake.backend.ensureVolume(data);

    await fake.backend.prepareNetwork();

    expect(await run(["sandbox", "reset", "--services"], harness.deps)).toBe(0);
    expect(gracefulStops(fake)).toEqual([first, second].sort());
    expect(fake.containers.has(pod)).toBe(false);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(true);
    expect(fake.volumes.has(data)).toBe(false);
    expect(harness.stdout()).toContain(`removed volume ${data}`);
  });

  it("refuses reset --services while a pi session runs", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const { pod } = plantServices(fake);
    const data = configVolumeName(harness.stateDir, "db-data");

    await harness.writeJson(harness.userConfigFile, { services: SERVICES });

    await fake.backend.ensureVolume(data);

    await registerSession(harness.stateDir, "e".repeat(64));

    expect(await run(["sandbox", "reset", "--services"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("a pi session is running, so the services were kept");
    expect(fake.containers.has(pod)).toBe(true);
    expect(fake.volumes.has(data)).toBe(true);
  });

  it("stops the idle services before pi sandbox stop stops the VM", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const { first, second } = plantServices(fake);

    expect(await run(["sandbox", "stop"], harness.deps)).toBe(0);
    expect(gracefulStops(fake)).toEqual([first, second].sort());
  });

  it("removes the container a crashed launch left before pi sandbox stop decides on the services", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const { first, second } = plantServices(fake);
    const crashed = fake.addContainer({
      name: "pi-sandbox-crashed",
      labels: { [LABELS.managed]: "true", [LABELS.role]: "agent", [LABELS.repoHash]: "d".repeat(64) },
      state: "running",
      image: "x",
    });

    expect(await run(["sandbox", "stop"], harness.deps)).toBe(0);
    expect(fake.containers.has(crashed)).toBe(false);
    expect(gracefulStops(fake)).toEqual([first, second].sort());
  });

  it("stops this install's services and proxy and counts the session of another install as busy", async () => {
    const busy: number[] = [];
    const fake = createFakeBackend({
      vm: {
        stop: async (options) => {
          busy.push((await options.busy()).count);

          return "stopped";
        },
      },
    });
    const harness = await createHarness({ backend: () => fake.backend });
    const token = stateLayout(harness.stateDir).proxy.token;
    const { first, second } = plantServices(fake);
    const other = fake.addContainer({
      name: "pi-sandbox-other",
      labels: { [LABELS.managed]: "true", [LABELS.install]: "otherinstall", [LABELS.role]: "agent" },
      state: "running",
      image: "x",
    });

    await proxyToken(harness.stateDir);

    expect(await run(["sandbox", "stop"], harness.deps)).toBe(0);
    expect(gracefulStops(fake)).toEqual([first, second].sort());
    expect(fake.containers.has(other)).toBe(true);
    expect(harness.proxyStops()).toBeGreaterThan(0);
    expect(existsSync(token)).toBe(false);
    expect(busy).toEqual([1]);
  });

  it("leaves the services to the VM refusing to stop while a session runs", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    plantServices(fake);

    await registerSession(harness.stateDir, sha256Hex(harness.repoRoot));

    await run(["sandbox", "stop"], harness.deps);

    expect(gracefulStops(fake)).toEqual([]);
  });
});
