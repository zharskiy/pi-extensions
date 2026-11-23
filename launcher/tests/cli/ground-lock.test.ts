import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { roleOf } from "../../backend/index.ts";
import {
  CLEANUP_WAITING,
  GROUND_WAITING,
  startServices,
  stopIdleGround,
  withGroundLock,
} from "../../cli/ground.ts";
import { run } from "../../cli/index.ts";
import { newLaunchId, registerLaunch } from "../../grants/index.ts";
import { processMark, stateLayout } from "../../shared/index.ts";
import { createFakeBackend, FAKE_NETWORK, FAKE_RELAY } from "../support/fake-backend.ts";
import { tempDir } from "../support/temp-dir.ts";
import { createHarness } from "./harness.ts";

type Fake = ReturnType<typeof createFakeBackend>;

const until = async (ready: () => boolean, left = 400): Promise<void> => {
  if (ready() || left === 0) {
    return;
  }

  await sleep(5);

  await until(ready, left - 1);
};

const DB = { name: "db", command: ["db"] };

const CACHE = { name: "cache", command: ["cache"] };

const registered = async (stateDir: string, repoHash: string) => {
  const launchId = newLaunchId();

  await registerLaunch(stateDir, { launchId, repoHash, startedAt: 1, ...(await processMark()) });

  return launchId;
};

const live = (fake: Fake) =>
  [...fake.containers.values()]
    .filter((entry) => entry.summary.state === "running")
    .map((entry) => roleOf(entry.summary.labels));

const start = (fake: Fake, stateDir: string, launchId: string, services = [DB, CACHE]) => {
  const lines: string[] = [];
  const started = startServices({
    backend: fake.backend,
    stateDir,
    launchId,
    services,
    image: "sha256:image",
    report: (line) => lines.push(line),
  });

  return { started, lines };
};

describe("the ground lock and the install-wide services", () => {
  it("starts nothing and takes no lock without services", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir("services");

    await withGroundLock({ stateDir }, () => start(fake, stateDir, "own", []).started);

    expect(fake.created).toEqual([]);
  });

  it("waits for the ground lock, says so, then starts the services", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir("services");
    const release = { now: (): void => undefined };
    const held = new Promise<void>((resolve) => {
      release.now = resolve;
    });
    const entered = { now: (): void => undefined };
    const inside = new Promise<void>((resolve) => {
      entered.now = resolve;
    });
    const holding = withGroundLock({ stateDir }, () => {
      entered.now();

      return held;
    });

    await inside;

    const { started, lines } = start(fake, stateDir, "own");

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fake.created).toEqual([]);
    expect(lines).toContain(GROUND_WAITING);

    release.now();

    await holding;

    await started;

    expect(live(fake)).toEqual(["pod", "service", "service"]);
  });

  it("keeps changed services while a session of another repository is live, and counts no own launch", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir("services");
    const own = await registered(stateDir, "a".repeat(64));

    await start(fake, stateDir, own).started;

    const replaced = start(fake, stateDir, own, [DB]);

    await replaced.started;

    expect(live(fake)).toEqual(["pod", "service"]);

    await registered(stateDir, "b".repeat(64));

    const kept = start(fake, stateDir, own, [DB, CACHE]);

    await kept.started;

    expect(live(fake)).toEqual(["pod", "service"]);
    expect(kept.lines).toEqual([
      "pi-sandbox: the services in the config changed; they restart once every pi session has ended",
    ]);
  });

  it("waits while the ground lock is held, says so, then stops the idle ground", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const stateDir = harness.stateDir;
    const release = { now: (): void => undefined };
    const held = new Promise<void>((resolve) => {
      release.now = resolve;
    });

    await start(fake, stateDir, "own").started;

    const holding = withGroundLock({ stateDir }, () => held);

    await sleep(20);

    const stopping = stopIdleGround(harness.deps, fake.backend);

    await sleep(300);

    expect(live(fake)).toEqual(["pod", "service", "service"]);
    expect(harness.stderr()).toContain(CLEANUP_WAITING);

    release.now();

    await holding;

    await stopping;

    expect(live(fake)).toEqual([]);
  });

  it("waits for the ground lock in stop, says so without offering Ctrl-C, then stops the proxy once", async () => {
    const harness = await createHarness();
    const release = { now: (): void => undefined };
    const held = new Promise<void>((resolve) => {
      release.now = resolve;
    });
    const holding = withGroundLock({ stateDir: harness.stateDir }, () => held);

    await sleep(20);

    const stopping = run(["sandbox", "stop"], harness.deps);

    await sleep(300);

    expect(harness.proxyStops()).toBe(0);
    expect(harness.stderr()).toBe(`${CLEANUP_WAITING}\n`);

    release.now();

    await holding;

    await stopping;

    expect(harness.proxyStops()).toBe(1);
  });

  it("ends the wait for the ground lock on an aborted signal and stops nothing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const stateDir = harness.stateDir;
    const skip = new AbortController();

    await start(fake, stateDir, "own").started;

    const stopped = await withGroundLock({ stateDir }, async () => {
      const stopping = stopIdleGround(harness.deps, fake.backend, skip.signal);

      await sleep(50);

      skip.abort();

      return stopping;
    });

    expect(stopped).toEqual([]);
    expect(live(fake)).toEqual(["pod", "service", "service"]);
  });

  it("stops nothing while a session is live", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const stateDir = harness.stateDir;

    await start(fake, stateDir, "own").started;

    await registered(stateDir, "b".repeat(64));

    expect(await stopIdleGround(harness.deps, fake.backend)).toEqual([]);
    expect(live(fake)).toEqual(["pod", "service", "service"]);
    expect(harness.proxyStops()).toBe(0);
  });

  it("rebuilds the network, relay, token and proxy for a launch that registered while a teardown held the lock", async () => {
    const fake = createFakeBackend();
    const teardown = { armed: false, entered: (): void => undefined, open: (): void => undefined };
    const entered = new Promise<void>((resolve) => {
      teardown.entered = resolve;
    });
    const opened = new Promise<void>((resolve) => {
      teardown.open = resolve;
    });
    const ports = { next: 3128 };
    const seen: Array<{ network: boolean; relayPort?: number; token: boolean }> = [];
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        exec: async (spec, io) => {
          if (spec.env.PI_SANDBOX_LAUNCH_ID !== undefined) {
            teardown.armed = true;

            seen.push({
              network: fake.networks.has(FAKE_NETWORK),
              relayPort: fake.relays.get(FAKE_RELAY)?.hostPort,
              token: existsSync(stateLayout(harness.stateDir).proxy.token),
            });
          }

          return fake.backend.exec(spec, io);
        },
        removeNetwork: async () => {
          if (teardown.armed) {
            teardown.armed = false;

            teardown.entered();

            await opened;
          }

          return fake.backend.removeNetwork();
        },
      }),
      proxy: {
        ensure: async () => {
          ports.next += 1;

          return {
            proxy: { pid: 4242, boot: 0, start: "", port: ports.next, inputHash: "input" },
            notices: [],
          };
        },
      },
    });
    const first = run([], harness.deps);

    await entered;

    const second = run([], harness.deps);

    await until(() => harness.stderr().includes(GROUND_WAITING));

    teardown.open();

    expect(await first).toBe(0);
    expect(await second).toBe(0);
    expect(harness.stderr()).toContain(GROUND_WAITING);
    expect(harness.proxyStops()).toBe(2);
    expect(seen).toEqual([
      { network: true, relayPort: 3129, token: true },
      { network: true, relayPort: 3130, token: true },
    ]);
  });

  it("stops the idle services, removes the relay and the install network, and stops the proxy", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await start(fake, harness.stateDir, "own").started;

    await fake.backend.prepareRelay({ hostPort: 3128, imageId: "relay", preamble: "PI-SANDBOX test" });

    const lines = await stopIdleGround(harness.deps, fake.backend);

    expect(lines).toHaveLength(5);
    expect(live(fake)).toEqual([]);
    expect(fake.relays.size).toBe(0);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(false);
    expect(harness.proxyStops()).toBe(1);
  });

  it("stops the proxy once in stop when listing the engine's containers fails", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        findContainers: () => Promise.reject(new Error("engine broke")),
      }),
    });

    expect(await run(["sandbox", "stop"], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain("the sweep of the folders' leftover sandboxes failed");
    expect(harness.stderr()).toContain("the sandbox network, proxy and services were not all stopped");
    expect(harness.proxyStops()).toBe(1);
  });

  it("warns once that the sweep failed when the daily clean-up after it fails", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        listVolumes: () => Promise.reject(new Error("engine broke")),
      }),
    });

    expect(await run(["sandbox", "stop"], harness.deps)).toBe(0);
    expect(harness.stderr().split("the sweep of leftover sandboxes failed").length - 1).toBe(1);
    expect(harness.proxyStops()).toBe(1);
  });
});
