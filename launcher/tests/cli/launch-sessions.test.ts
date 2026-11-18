import { EventEmitter } from "node:events";
import { lstat, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { liveLaunches, registerLaunch } from "../../grants/index.ts";
import { processMark, sha256Hex, stateLayout } from "../../shared/index.ts";
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
    const [created] = fake.created;
    const left = await filesUnder(harness.stateDir);

    expect(created?.spec?.env.HTTPS_PROXY).toContain("@pi-sandbox-proxy:3128");
    expect(fake.containers.size).toBe(0);
    expect(fake.relays.size).toBe(0);
    expect([...fake.networks.keys()]).toEqual([]);
    expect(harness.stoppedProxies).toEqual([repo, repo]);
    expect(left).toEqual(before);
    expect(left).not.toContain(files.proxy.token);
    expect(left).not.toContain(files.created);
    expect(left.filter((path) => /\/git\/[0-9a-f]{16}$/.test(path))).toEqual([]);
    expect(await lstat(join(harness.repoRoot, ".git", "commondir")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(files.record, "utf8")).toContain(harness.repoRoot);
  });

  it("removes its own container at the end, and the relay and network only after the last session of the repository", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await registerLaunch(harness.stateDir, {
      ...(await processMark()),
      launchId: "0123456789abcdef",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
    });

    await run([], harness.deps);

    expect(fake.created).toHaveLength(1);
    expect(fake.containers.size).toBe(0);
    expect(fake.relays.size).toBe(1);
    expect(fake.networks.size).toBe(1);
    expect(harness.stoppedProxies).toEqual([]);
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
      removeRepoNetwork: async (repoHash: string) => {
        order.push("network");

        return fake.backend.removeRepoNetwork(repoHash);
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
    const repo = sha256Hex(harness.repoRoot);

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(1);
    expect(harness.stoppedProxies).toContain(repo);
    expect(
      await lstat(stateLayout(harness.stateDir).repo(repo).proxy.token).catch(() => undefined),
    ).toBeUndefined();

    engine.up = true;

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(0);
  });
});

describe("the git report at the last session's end", () => {
  it("finishes under the launch lock, so a launch registering right after sees no baseline of the ended one", async () => {
    const fake = createFakeBackend();
    const seen: { ending?: boolean; atEnd?: boolean; atRegistration?: boolean; registered?: Promise<void> } =
      {};
    const harness = await createHarness({
      respond: (call) =>
        seen.ending === true && call.file === "git" && call.args.includes("ls-files")
          ? sleep(300).then(() => ({ code: 1 }))
          : undefined,
      backend: () => ({
        ...fake.backend,
        removeRepoNetwork: async (repoHash: string) => {
          seen.ending = true;
          seen.atEnd = await exists(baseline());

          seen.registered = registerLaunch(harness.stateDir, {
            launchId: OTHER_LAUNCH,
            repoHash,
            startedAt: 2,
            ...(await processMark()),
          }).then(async () => {
            seen.atRegistration = await exists(baseline());
          });

          return fake.backend.removeRepoNetwork(repoHash);
        },
      }),
    });
    const baseline = () => stateLayout(harness.stateDir).repo(sha256Hex(harness.repoRoot)).gitBaseline;

    expect(await run([], harness.deps)).toBe(0);

    await seen.registered;

    expect(seen).toMatchObject({ atEnd: true, atRegistration: false });
  });
});

describe("the sweep of what a killed launcher left", () => {
  it("removes the sandbox of another repository whose launcher is gone and its pid reused, at the next launch", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const orphan = "b".repeat(64);
    const files = stateLayout(harness.stateDir).repo(orphan);

    await harness.writeJson(join(files.launches, "00000000000000ee.json"), {
      launchId: "00000000000000ee",
      ...(await processMark()),
      start: "Thu-Jan-1-00:00:00-1970",
      repoHash: orphan,
      startedAt: 1,
    });

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

    await utimes(join(stateLayout(harness.stateDir).repo(other).launches, "00000000000000ff.json"), old, old);

    const id = fake.addContainer({
      name: `pi-sandbox-${other.slice(0, 12)}`,
      labels: {
        "pi-sandbox.managed": "true",
        "pi-sandbox.repo-hash": other,
        "pi-sandbox.launch-id": "00000000000000ff",
      },
      state: "running",
      image: "x",
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.containers.has(id)).toBe(true);
    expect(harness.stoppedProxies).not.toContain(other);
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
    expect(await launchesShown(harness)).toBe(`launches: 0 running in ${harness.repoRoot}`);
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
    expect(await launchesShown(harness)).toBe(`launches: 0 running in ${harness.repoRoot}`);
  });
});

describe("a launch refused right before its start", () => {
  it("refuses when .git/hooks turned into a file before the start, and leaves no container", async () => {
    const fake = createFakeBackend();
    const box = { planted: false, root: "" };
    const backend: typeof fake.backend = {
      ...fake.backend,
      findContainers: async (labels) => {
        if (!box.planted && labels["pi-sandbox.repo-hash"] === sha256Hex(box.root)) {
          box.planted = true;

          await rm(join(box.root, ".git", "hooks"), { recursive: true, force: true });

          await writeFile(join(box.root, ".git", "hooks"), "");
        }

        return fake.backend.findContainers(labels);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    box.root = harness.repoRoot;

    expect(await run([], harness.deps)).toBe(1);
    expect(box.planted).toBe(true);
    expect(harness.stderr()).toContain(`${join(harness.repoRoot, ".git", "hooks")} is not a directory`);
    expect(fake.containers.size).toBe(0);
  });
});
