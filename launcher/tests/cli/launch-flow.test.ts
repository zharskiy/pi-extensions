import { EventEmitter } from "node:events";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { Backend, VmPath } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { hostSessionsDir } from "../../workspace/index.ts";
import { createFakeBackend, createHarness, piSessions, renderDirOf } from "./harness.ts";

const STOPPING = "pi-sandbox: stopping after the current step\n";

const POLL_MS = 5;

const POLLS = 400;

const waitFor = async (ready: () => boolean, left = POLLS): Promise<boolean> => {
  if (ready() || left === 0) {
    return ready();
  }

  await sleep(POLL_MS);

  return waitFor(ready, left - 1);
};

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const occurrences = (text: string, part: string) => text.split(part).length - 1;

describe("signals from the launch registration to the end of the session", () => {
  it("says once that it stops after the current step, then leaves a second signal to the default handler", async () => {
    const signals = new EventEmitter();
    const fake = createFakeBackend();
    const counts: number[] = [];
    const backend: Backend = {
      ...fake.backend,
      buildImage: async (...args: Parameters<Backend["buildImage"]>) => {
        counts.push(signals.listenerCount("SIGINT"));

        signals.emit("SIGINT");

        counts.push(signals.listenerCount("SIGINT"), signals.listenerCount("SIGTERM"));

        return fake.backend.buildImage(...args);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    harness.deps.signals = signals;

    expect(await run([], harness.deps)).toBe(130);
    expect(counts).toEqual([1, 0, 0]);
    expect(occurrences(harness.stderr(), STOPPING)).toBe(1);
    expect(piSessions(fake)).toEqual([]);
    expect(fake.containers.size).toBe(0);
  });

  it("leaves signals to the default handler while pi runs", async () => {
    const signals = new EventEmitter();
    const fake = createFakeBackend();
    const counts: number[] = [];
    const backend: Backend = {
      ...fake.backend,
      exec: async (spec, io) => {
        if (spec.env.PI_SANDBOX_LAUNCH_ID !== undefined) {
          counts.push(signals.listenerCount("SIGINT"));
        }

        return fake.backend.exec(spec, io);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    harness.deps.signals = signals;

    expect(await run([], harness.deps)).toBe(0);
    expect(counts).toEqual([1]);
  });

  it("swallows a signal while the session ends, so the cleanup finishes", async () => {
    const signals = new EventEmitter();
    const fake = createFakeBackend();
    const counts: number[] = [];
    const backend: Backend = {
      ...fake.backend,
      stopContainer: async (id: string, timeoutSeconds?: number) => {
        counts.push(signals.listenerCount("SIGHUP"));

        signals.emit("SIGHUP");

        return fake.backend.stopContainer(id, timeoutSeconds);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    harness.deps.signals = signals;

    expect(await run([], harness.deps)).toBe(0);
    expect(counts[0]).toBeGreaterThan(0);
    expect(fake.containers.size).toBe(0);
    expect(signals.listenerCount("SIGHUP")).toBe(0);
  });
});

describe("work that runs side by side", () => {
  it("renders the agent dir while the image is still being built", async () => {
    const fake = createFakeBackend();
    const seen: boolean[] = [];
    const rendered = { now: false };
    const backend: Backend = {
      ...fake.backend,
      buildImage: async (...args: Parameters<Backend["buildImage"]>) => {
        const watching = setInterval(() => {
          exists(join(renderDirOf(harness), "auth.json")).then((found) => {
            rendered.now = found;
          });
        }, POLL_MS);

        seen.push(await waitFor(() => rendered.now));

        clearInterval(watching);

        return fake.backend.buildImage(...args);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(seen).toEqual([true]);
  });

  it("derives the host side while the sandbox VM starts", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        vm: {
          ...fake.backend.vm,
          ensureRunning: async () => {
            started.push(await waitFor(() => trusted.length > 0));
          },
        },
      }),
      proxy: {
        trust: async () => {
          trusted.push(true);

          return {
            pemPath: harness.trustPem,
            caCertPath: harness.trustPem,
            extraPemPath: join(harness.stateDir, "ca", "extra.pem"),
            hash: "trust-hash",
          };
        },
      },
    });
    const started: boolean[] = [];
    const trusted: boolean[] = [];

    expect(await run([], harness.deps)).toBe(0);
    expect(started).toEqual([true]);
  });

  it("resolves the rule hosts for the private-address notice off the critical path", async () => {
    const fake = createFakeBackend();
    const gate = { open: false };
    const backend: Backend = {
      ...fake.backend,
      buildImage: async (...args: Parameters<Backend["buildImage"]>) => {
        gate.open = true;

        return fake.backend.buildImage(...args);
      },
    };
    const harness = await createHarness({
      backend: () => backend,
      resolve: async () => ((await waitFor(() => gate.open)) ? ["10.0.0.7"] : []),
    });

    harness.deps.dnsWaitMs = 10_000;

    await harness.writeJson(join(harness.hostAgentDir, "auth.json"), {
      example: { type: "api_key", key: "sk-real-key-0123456789" },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain("pi-sandbox: models.example.test resolves to a private address");
  });
});

describe("the VM shares", () => {
  it("creates the host session dir before the VM is asked to share it, and passes the same paths to the start", async () => {
    const fake = createFakeBackend();
    const asked: { running?: VmPath[]; shared?: VmPath[]; existed?: boolean } = {};
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        vm: {
          ...fake.backend.vm,
          ensureRunning: async (_report, shares) => {
            asked.running = shares;
          },
          ensureShares: async (paths) => {
            asked.shared = paths;
            asked.existed = await exists(hostSessionsDir(harness.hostAgentDir, harness.repoRoot));
          },
        },
      }),
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(asked.existed).toBe(true);
    expect(asked.running).toEqual(asked.shared);
    expect(asked.shared?.map((need) => need.path)).toContain(
      hostSessionsDir(harness.hostAgentDir, harness.repoRoot),
    );
  });

  it("does not share the session dir when the host settings name their own session dir", async () => {
    const fake = createFakeBackend();
    const asked: { shared?: VmPath[] } = {};
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        vm: {
          ...fake.backend.vm,
          ensureShares: async (paths) => {
            asked.shared = paths;
          },
        },
      }),
    });

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), { sessionDir: "/elsewhere" });

    expect(await run([], harness.deps)).toBe(0);
    expect(asked.shared?.map((need) => need.path)).not.toContain(
      hostSessionsDir(harness.hostAgentDir, harness.repoRoot),
    );
  });
});

describe("the doctor and the VM", () => {
  it("starts the VM without asking for shares and never restarts it to share a path", async () => {
    const fake = createFakeBackend();
    const asked: { running: Array<VmPath[] | undefined>; shared: number } = { running: [], shared: 0 };
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        vm: {
          ...fake.backend.vm,
          ensureRunning: async (_report, shares) => {
            asked.running.push(shares);
          },
          ensureShares: async () => {
            asked.shared += 1;
          },
        },
      }),
    });

    await run(["sandbox", "doctor"], harness.deps);

    expect(asked.running).toEqual([undefined]);
    expect(asked.shared).toBe(0);
  });
});
