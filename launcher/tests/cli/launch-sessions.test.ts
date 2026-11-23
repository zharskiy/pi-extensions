import { EventEmitter } from "node:events";
import { lstat, mkdir, readdir, readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { LABELS } from "../../backend/index.ts";
import { openContext } from "../../cli/context.ts";
import { CLEANUP_WAITING, withGroundLock } from "../../cli/ground.ts";
import { run } from "../../cli/index.ts";
import { withSandbox } from "../../cli/launch.ts";
import { beginLaunch, finishLaunch } from "../../cli/launches.ts";
import { withPrepareLock } from "../../cli/prepare.ts";
import { liveLaunches, registerLaunch } from "../../grants/index.ts";
import { processMark, recordCreatedDirs, sha256Hex, stateLayout } from "../../shared/index.ts";
import { FAKE_NETWORK } from "../support/fake-backend.ts";
import { createFakeBackend, createHarness, piSessions, sweepNow } from "./harness.ts";

const POLL_MS = 5;

const POLLS = 200;

const _waitFor = async (ready: () => boolean, left = POLLS): Promise<boolean> => {
  if (ready() || left === 0) {
    return ready();
  }

  await sleep(POLL_MS);

  return _waitFor(ready, left - 1);
};

const OTHER_LAUNCH = "00000000000000aa";

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const filesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? filesUnder(join(dir, entry.name)).then((files) => [join(dir, entry.name), ...files])
        : Promise.resolve([join(dir, entry.name)]),
    ),
  );

  return nested.flat();
};

const launchesShown = async (harness: Awaited<ReturnType<typeof createHarness>>) => {
  await run(["sandbox", "status"], harness.deps);

  return harness
    .stdout()
    .split("\n")
    .findLast((line) => line.startsWith("launches: "));
};

describe("the end of a session", () => {
  it("leaves the engine and the state dir in their steady state after the last session exits", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const repo = sha256Hex(harness.repoRoot);

    expect(await run([], harness.deps)).toBe(0);

    const before = await filesUnder(harness.stateDir);

    expect(await run([], harness.deps)).toBe(0);

    const files = stateLayout(harness.stateDir).repo(repo);
    const token = stateLayout(harness.stateDir).proxy.token;
    const [created] = fake.created;
    const left = await filesUnder(harness.stateDir);

    expect(created?.spec?.env.HTTPS_PROXY).toBe("http://pi-sandbox-proxy:3128");
    expect(fake.containers.size).toBe(0);
    expect(fake.relays.size).toBe(0);
    expect([...fake.networks.keys()]).toEqual([]);
    expect(harness.proxyStops()).toBe(2);
    expect(left).toEqual(before);
    expect(left).not.toContain(token);
    expect(left).not.toContain(files.created);
    expect(left.filter((path) => /\/git\/[0-9a-f]{16}$/.test(path))).toEqual([]);
    expect(await lstat(join(harness.repoRoot, ".git", "commondir")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(files.record, "utf8")).toContain(harness.repoRoot);
  });

  it("removes its own container at the end, and the relay, network and proxy only after the last session of the install", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await registerLaunch(harness.stateDir, {
      ...(await processMark()),
      launchId: "0123456789abcdef",
      pid: process.pid,
      repoHash: "d".repeat(64),
      startedAt: 1,
    });

    await run([], harness.deps);

    expect(fake.created).toHaveLength(1);
    expect(fake.containers.size).toBe(0);
    expect(fake.relays.size).toBe(1);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(true);
    expect(harness.proxyStops()).toBe(0);
  });

  it("removes its own container first, then the relay and the network", async () => {
    const fake = createFakeBackend();
    const order: string[] = [];
    const backend = {
      ...fake.backend,
      removeContainer: async (id: string) => {
        order.push(`remove ${id.split("-")[0]}`);

        await fake.backend.removeContainer(id);
      },
      removeNetwork: async () => {
        order.push("network");

        return fake.backend.removeNetwork();
      },
    };
    const harness = await createHarness({ backend: () => backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(order).toEqual(["remove container", "remove relay", "network"]);
  });

  it("tolerates a container the engine already removed or is still removing", async () => {
    const fake = createFakeBackend();
    const backend = {
      ...fake.backend,
      removeContainer: async () => undefined,
    };
    const harness = await createHarness({ backend: () => backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).not.toContain("warning");
    expect(fake.networks.size).toBe(0);
  });

  it("releases the proxy when the engine is gone at the end, and the next sweep removes the container", async () => {
    const fake = createFakeBackend();
    const engine = { up: true };
    const backend: typeof fake.backend = {
      ...fake.backend,
      detect: async () => (engine.up ? { available: true } : { available: false, reason: "gone" }),
      exec: async (spec, io) => {
        if (spec.env.PI_SANDBOX_LAUNCH_ID !== undefined) {
          engine.up = false;
        }

        return fake.backend.exec(spec, io);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(1);
    expect(harness.proxyStops()).toBe(1);
    expect(await exists(stateLayout(harness.stateDir).proxy.token)).toBe(false);

    engine.up = true;

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(0);
  });
});

describe("the cleanup at the end of a folder's last session", () => {
  it("lets a launch of another folder register while the cleanup is slow", async () => {
    const fake = createFakeBackend();
    const cleanup = { ending: false, entered: (): void => undefined, open: (): void => undefined };
    const entered = new Promise<void>((resolve) => {
      cleanup.entered = resolve;
    });
    const opened = new Promise<void>((resolve) => {
      cleanup.open = resolve;
    });
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        findContainers: async (labels) => {
          if (cleanup.ending && labels[LABELS.repoHash] !== undefined) {
            cleanup.entered();

            await opened;
          }

          return fake.backend.findContainers(labels);
        },
      }),
    });
    const own = await openContext(harness.deps, "host");
    const launch = await beginLaunch(harness.deps, own.context, () => undefined);

    cleanup.ending = true;

    const finished = finishLaunch(
      harness.deps,
      own.context,
      harness.deps.backend(),
      launch,
      new AbortController().signal,
    );

    await entered;

    const other = await openContext({ ...harness.deps, cwd: harness.deps.home }, "host");
    const begun = await Promise.race([
      beginLaunch(harness.deps, other.context, () => undefined).then(() => "registered"),
      sleep(2000).then(() => "blocked"),
    ]);

    cleanup.open();

    await finished;

    expect(begun).toBe("registered");
    expect((await liveLaunches(harness.stateDir)).map((entry) => entry.repoHash)).toEqual([
      other.context.repoHash,
    ]);
  });

  it("cleans the folder and the install ground when the folder's two last sessions end together while both locks are held", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const own = await openContext(harness.deps, "host");
    const mountDir = join(harness.repoRoot, "created-mount");

    await fake.backend.prepareRelay({ hostPort: 3128, imageId: "relay", preamble: "PI-SANDBOX test" });

    await mkdir(mountDir);

    await recordCreatedDirs(harness.stateDir, own.context.repoHash, [mountDir]);

    const launches = [
      await beginLaunch(harness.deps, own.context, () => undefined),
      await beginLaunch(harness.deps, own.context, () => undefined),
    ];
    const backend = harness.deps.backend();
    const lock = { stateDir: harness.stateDir, repoHash: own.context.repoHash, progress: () => undefined };
    const preparing = withPrepareLock(lock, () => sleep(300));
    const grounding = withGroundLock(lock, () => sleep(600));

    await sleep(20);

    await Promise.all([
      ...launches.map((launch) =>
        finishLaunch(harness.deps, own.context, backend, launch, new AbortController().signal),
      ),
      preparing,
      grounding,
    ]);

    expect(await liveLaunches(harness.stateDir)).toEqual([]);
    expect(await exists(mountDir)).toBe(false);
    expect(fake.relays.size).toBe(0);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(false);
    expect(harness.proxyStops()).toBeGreaterThan(0);
  });

  it("waits for a host pi job's sweep holding the folder's prepare lock, says so, then cleans the folder", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const own = await openContext(harness.deps, "host");
    const mountDir = join(harness.repoRoot, "created-mount");
    const release = { now: (): void => undefined };
    const held = new Promise<void>((resolve) => {
      release.now = resolve;
    });

    await mkdir(mountDir);

    await recordCreatedDirs(harness.stateDir, own.context.repoHash, [mountDir]);

    const launch = await beginLaunch(harness.deps, own.context, () => undefined);
    const lock = { stateDir: harness.stateDir, repoHash: own.context.repoHash, progress: () => undefined };
    const sweeping = withPrepareLock(lock, () => held);

    await sleep(20);

    const finished = finishLaunch(
      harness.deps,
      own.context,
      harness.deps.backend(),
      launch,
      new AbortController().signal,
    );

    await sleep(300);

    expect(await exists(mountDir)).toBe(true);
    expect(harness.stderr()).toContain(CLEANUP_WAITING);

    release.now();

    await sweeping;

    await finished;

    expect(await exists(mountDir)).toBe(false);
  });
});

describe("the sweep of what a killed launcher left", () => {
  it("removes the sandbox of another repository whose launcher is gone and its pid reused, at the next launch, and keeps a container without a role", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const orphan = "b".repeat(64);
    const layout = stateLayout(harness.stateDir);

    await harness.writeJson(join(layout.launches, "00000000000000ee.json"), {
      launchId: "00000000000000ee",
      ...(await processMark()),
      start: "Thu-Jan-1-00:00:00-1970",
      repoHash: orphan,
      startedAt: 1,
    });

    await harness.writeJson(layout.proxy.token, "token");

    const id = fake.addContainer({
      name: `pi-sandbox-${orphan.slice(0, 12)}`,
      labels: {
        [LABELS.managed]: "true",
        [LABELS.role]: "agent",
        [LABELS.repoHash]: orphan,
        [LABELS.launchId]: "00000000000000ee",
      },
      state: "running",
      image: "x",
    });
    const roleless = fake.addContainer({
      name: "pi-sandbox-build-step",
      labels: { [LABELS.managed]: "true", [LABELS.repoHash]: orphan },
      state: "running",
      image: "x",
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.containers.has(id)).toBe(false);
    expect(fake.containers.has(roleless)).toBe(true);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(false);
    expect(harness.proxyStops()).toBe(1);
    expect(await exists(layout.proxy.token)).toBe(false);
  });

  it("keeps the sandbox of another repository while its launcher runs, even when its entry is hours old after a sleep", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const other = "c".repeat(64);
    const old = new Date(Date.now() - 6 * 60 * 60 * 1000);

    await registerLaunch(harness.stateDir, {
      launchId: "00000000000000ff",
      ...(await processMark()),
      repoHash: other,
      startedAt: 1,
    });

    await utimes(join(stateLayout(harness.stateDir).launches, "00000000000000ff.json"), old, old);

    const id = fake.addContainer({
      name: `pi-sandbox-${other.slice(0, 12)}`,
      labels: {
        [LABELS.managed]: "true",
        [LABELS.role]: "agent",
        [LABELS.repoHash]: other,
        [LABELS.launchId]: "00000000000000ff",
      },
      state: "running",
      image: "x",
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.containers.has(id)).toBe(true);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(true);
    expect(harness.proxyStops()).toBe(0);
  });
});

describe("a config change while other sessions of the repository are live", () => {
  it("applies to the next launch at once, in a container of its own", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await registerLaunch(harness.stateDir, {
      launchId: OTHER_LAUNCH,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
      ...(await processMark()),
    });

    expect(await run([], harness.deps)).toBe(0);

    await harness.writeJson(harness.userConfigFile, { env: { allow: ["EDITOR"] } });

    harness.deps.env.EDITOR = "vi";

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.created).toHaveLength(2);
    expect(piSessions(fake).at(-1)?.spec.env.EDITOR).toBe("vi");
    expect(harness.stderr()).not.toContain("the sandbox config changed");
  });
});

describe("a signal while the sandbox is being prepared", () => {
  it("lets the container start finish, never runs pi, then ends the session, stops the container and exits 128 plus the signal number", async () => {
    const signals = new EventEmitter();
    const fake = createFakeBackend();
    const backend = {
      ...fake.backend,
      startContainer: async (id: string) => {
        signals.emit("SIGTERM");

        await sleep(50);

        await fake.backend.startContainer(id);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    harness.deps.signals = signals;

    expect(await run([], harness.deps)).toBe(143);
    expect(fake.created).toHaveLength(1);
    expect(fake.containers.size).toBe(0);
    expect(fake.stops.map((stop) => stop.id)).toContain(fake.created[0]?.summary.id);
    expect(await launchesShown(harness)).toBe("launches: 0 running in the sandbox");
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(piSessions(fake)).toEqual([]);
  });

  it("creates no container when Ctrl-C arrives during the image build, and ends the session only after the build", async () => {
    const signals = new EventEmitter();
    const fake = createFakeBackend();
    const sessionsWhenBuilt: number[] = [];
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        buildImage: async (...args: Parameters<typeof fake.backend.buildImage>) => {
          signals.emit("SIGINT");

          await sleep(50);

          sessionsWhenBuilt.push((await liveLaunches(harness.stateDir)).length);

          return fake.backend.buildImage(...args);
        },
      }),
    });

    harness.deps.signals = signals;

    expect(await run([], harness.deps)).toBe(130);
    expect(sessionsWhenBuilt).toEqual([1, 1]);
    expect(fake.containers.size).toBe(0);
    expect(await launchesShown(harness)).toBe("launches: 0 running in the sandbox");
  });
});

describe("a failure right after the launch registered", () => {
  it("ends the launch, so no session stays registered", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const { context, backend } = await openContext(harness.deps, "sandbox");
    const config = context.effective.config;
    const failing = {
      ...context,
      effective: {
        ...context.effective,
        config: {
          ...config,
          get writeBack(): typeof config.writeBack {
            throw new Error("write-back table failed");
          },
        },
      },
    };

    await expect(withSandbox(harness.deps, failing, backend, async () => 0)).rejects.toThrow(
      "write-back table failed",
    );

    expect(await liveLaunches(harness.stateDir)).toEqual([]);
  });
});
