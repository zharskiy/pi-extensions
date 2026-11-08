import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { liveSessions, registerSession } from "../../grants/index.ts";
import { sha256Hex } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createHarness, piSessions } from "./harness.ts";

const OUTDATED =
  "pi-sandbox: the sandbox config changed; it applies after every session in this repository exits";

const OTHER_LAUNCH = "00000000000000aa";

describe("the end of a session", () => {
  it("stops the container when the last session of the repository ends", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];

    expect(container?.summary.state).toBe("stopped");
    expect(fake.stops.map((stop) => stop.id)).toEqual([container?.summary.id]);
  });

  it("keeps the container running while another session of the repository is live", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await registerSession(harness.stateDir, {
      launchId: "0123456789abcdef",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
    });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];

    expect(container?.summary.state).toBe("running");
    expect(fake.stops).toEqual([]);
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
    };

    await registerSession(harness.stateDir, other);

    expect(await run([], harness.deps)).toBe(0);

    const [first] = [...fake.containers.keys()];

    await harness.writeJson(harness.userConfigFile, { mounts: { cacheVolumes: ["vendor"] } });

    expect(await run([], harness.deps)).toBe(0);
    expect([...fake.containers.keys()]).toEqual([first]);
    expect(harness.stderr()).toContain(OUTDATED);
    expect(fake.stops).toEqual([]);

    await registerSession(harness.stateDir, { ...other, pid: 2 ** 22 + 12345 });

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.containers.has(first ?? "")).toBe(false);
    expect(fake.containers.size).toBe(1);
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
    expect(fake.containers.size).toBe(1);
    expect(fake.stops.map((stop) => stop.id)).toEqual([...fake.containers.keys()]);
    expect(await liveSessions(harness.stateDir)).toEqual([]);
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

          sessionsWhenBuilt.push((await liveSessions(harness.stateDir)).length);

          return fake.backend.buildImage(...args);
        },
      }),
    });

    harness.deps.signals = signals;

    expect(await run([], harness.deps)).toBe(130);
    expect(sessionsWhenBuilt).toEqual([1]);
    expect(fake.containers.size).toBe(0);
    expect(await liveSessions(harness.stateDir)).toEqual([]);
  });
});
