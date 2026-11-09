import { EventEmitter } from "node:events";
import { lstat, readdir, readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { liveLaunches, registerLaunch } from "../../grants/index.ts";
import { bootTime, sha256Hex, stateLayout } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createHarness, piSessions } from "./harness.ts";

const OUTDATED =
  "pi-sandbox: the sandbox config changed; it applies after every session in this repository exits";

const OTHER_LAUNCH = "00000000000000aa";

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

const withCacheMount = (harness: Awaited<ReturnType<typeof createHarness>>) =>
  harness.writeJson(harness.userConfigFile, { mounts: { cacheVolumes: ["deep/cache"] } });

describe("the end of a session", () => {
  it("leaves the engine and the state dir in their steady state after the last session exits", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const repo = sha256Hex(harness.repoRoot);

    await withCacheMount(harness);

    expect(await run([], harness.deps)).toBe(0);

    const before = await filesUnder(harness.stateDir);

    expect(await run([], harness.deps)).toBe(0);

    const files = stateLayout(harness.stateDir).repo(repo);
    const [created] = fake.created;
    const left = await filesUnder(harness.stateDir);

    expect(created?.spec?.env.HTTPS_PROXY).toContain("@pi-sandbox-proxy:3128");
    expect(fake.containers.size).toBe(0);
    expect(fake.relays.size).toBe(0);
    expect([...fake.networks.keys()]).toEqual([]);
    expect(harness.stoppedProxies).toEqual([repo, repo]);
    expect(left).toEqual(before);
    expect(left).not.toContain(files.proxy.token);
    expect(left).not.toContain(files.pins);
    expect(left).not.toContain(files.created);
    expect(left.filter((path) => /\/git\/[0-9a-f]{16}$/.test(path))).toEqual([]);
    expect(await lstat(join(harness.repoRoot, ".git", "commondir")).catch(() => undefined)).toBeUndefined();
    expect(await lstat(join(harness.repoRoot, "deep")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(files.record, "utf8")).toContain(harness.repoRoot);
  });

  it("removes the container, relay and network only after the last session of the repository ends", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await registerLaunch(harness.stateDir, {
      boot: bootTime(),
      launchId: "0123456789abcdef",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
    });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];

    expect(container?.summary.state).toBe("running");
    expect(fake.relays.size).toBe(1);
    expect(fake.stops).toEqual([]);
    expect(harness.stoppedProxies).toEqual([]);
  });

  it("waits for the engine to remove the stopped container before it removes the network", async () => {
    const fake = createFakeBackend();
    const order: string[] = [];
    const backend = {
      ...fake.backend,
      waitRemoved: async (id: string, timeoutMs: number) => {
        order.push(`wait ${id.split("-")[0]}`);

        await fake.backend.waitRemoved(id, timeoutMs);
      },
      removeContainer: async (id: string) => {
        order.push(`remove ${id.split("-")[0]}`);

        await fake.backend.removeContainer(id);
      },
      removeRepoNetwork: async (repoHash: string) => {
        order.push("network");

        return fake.backend.removeRepoNetwork(repoHash);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(order).toEqual(["wait container", "remove container", "wait relay", "remove relay", "network"]);
  });

  it("tolerates a container the engine already removed or is still removing", async () => {
    const fake = createFakeBackend();
    const backend = {
      ...fake.backend,
      removeContainer: async () => undefined,
      waitRemoved: async () => undefined,
    };
    const harness = await createHarness({ backend: () => backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).not.toContain("warning");
    expect(fake.networks.size).toBe(0);
  });

  it("still releases the pins, the proxy and the created dirs when the engine is gone at the end", async () => {
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
    const repo = sha256Hex(harness.repoRoot);

    await withCacheMount(harness);

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(1);
    expect(harness.stoppedProxies).toEqual([repo]);
    expect(
      await lstat(stateLayout(harness.stateDir).repo(repo).proxy.token).catch(() => undefined),
    ).toBeUndefined();
    expect(await lstat(join(harness.repoRoot, ".git", "commondir")).catch(() => undefined)).toBeUndefined();
    expect(await lstat(join(harness.repoRoot, "deep")).catch(() => undefined)).toBeUndefined();
  });
});

describe("the sweep of what a killed launcher left", () => {
  it("removes the sandbox of another repository whose launcher stopped its heartbeat, at the next launch", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const orphan = "b".repeat(64);
    const files = stateLayout(harness.stateDir).repo(orphan);
    const entry = join(files.launches, "00000000000000ee.json");
    const old = new Date(Date.now() - 120_000);

    await harness.writeJson(entry, {
      launchId: "00000000000000ee",
      pid: process.pid,
      boot: bootTime(),
      repoHash: orphan,
      startedAt: 1,
    });

    await utimes(entry, old, old);

    await harness.writeJson(files.proxy.token, "token");

    await fake.backend.prepareProxyRoute({ hostPort: 3128, repoHash: orphan, imageId: "relay" });

    const id = fake.addContainer({
      name: `pi-sandbox-${orphan.slice(0, 12)}`,
      labels: { "pi-sandbox.managed": "true", "pi-sandbox.repo-hash": orphan },
      state: "running",
      image: "x",
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.containers.has(id)).toBe(false);
    expect(fake.relays.has(orphan)).toBe(false);
    expect(fake.networks.has(`pi-sandbox-${orphan.slice(0, 12)}`)).toBe(false);
    expect(harness.stoppedProxies).toContain(orphan);
    expect(await lstat(files.proxy.token).catch(() => undefined)).toBeUndefined();
  });

  it("keeps the sandbox of another repository while its launcher keeps its heartbeat", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const other = "c".repeat(64);

    await registerLaunch(harness.stateDir, {
      launchId: "00000000000000ff",
      pid: process.pid,
      boot: bootTime(),
      repoHash: other,
      startedAt: 1,
    });

    const id = fake.addContainer({
      name: `pi-sandbox-${other.slice(0, 12)}`,
      labels: { "pi-sandbox.managed": "true", "pi-sandbox.repo-hash": other },
      state: "running",
      image: "x",
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.containers.has(id)).toBe(true);
    expect(harness.stoppedProxies).not.toContain(other);
  });
});

describe("a config change while other sessions of the repository are live", () => {
  it("keeps the shared container with a notice, then replaces it once the others have exited", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const other = {
      launchId: OTHER_LAUNCH,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
      pid: process.pid,
      boot: bootTime(),
    };

    await registerLaunch(harness.stateDir, other);

    expect(await run([], harness.deps)).toBe(0);

    const [first] = [...fake.containers.keys()];

    await harness.writeJson(harness.userConfigFile, { mounts: { cacheVolumes: ["vendor"] } });

    expect(await run([], harness.deps)).toBe(0);
    expect([...fake.containers.keys()]).toEqual([first]);
    expect(harness.stderr()).toContain(OUTDATED);

    await registerLaunch(harness.stateDir, { ...other, pid: 2 ** 22 + 12345 });

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.containers.has(first ?? "")).toBe(false);
    expect(fake.created).toHaveLength(2);
    expect(fake.containers.size).toBe(0);
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
    expect(await liveLaunches(harness.stateDir)).toEqual([]);
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
    expect(sessionsWhenBuilt).toEqual([1]);
    expect(fake.containers.size).toBe(0);
    expect(await liveLaunches(harness.stateDir)).toEqual([]);
  });
});
