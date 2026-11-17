import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { Backend, MountSpec, VmPath, VmTarget } from "../../backend/index.ts";
import { onClosedOutput } from "../../cli/deps.ts";
import { run } from "../../cli/index.ts";
import { hostPathNotices, launchNotices } from "../../cli/launch-notices.ts";
import { liveLaunches } from "../../grants/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { hostSessionsDir } from "../../workspace/index.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { exists, realTempDir } from "../support/temp-dir.ts";
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
});

describe("the sweep at launch", () => {
  it("turns an engine detection that throws into the sweep warning and launches", async () => {
    const fake = createFakeBackend();
    const detections: string[] = [];
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        detect: async () => {
          detections.push("detect");

          if (detections.length === 1) {
            throw new Error("detection broke");
          }

          return fake.backend.detect();
        },
      }),
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain(
      "pi-sandbox: warning: the sweep of leftover sandboxes failed: detection broke\n",
    );
  });
});

describe("the VM shares", () => {
  it("creates the host session dir before the VM is asked to share it", async () => {
    const fake = createFakeBackend();
    const asked: { shared?: VmPath[]; existed?: boolean } = {};
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        vm: {
          ...fake.backend.vm,
          reconcile: async ({ needs }) => {
            asked.shared = needs;
            asked.existed = await exists(hostSessionsDir(harness.hostAgentDir, harness.repoRoot));
          },
        },
      }),
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(asked.existed).toBe(true);
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
          reconcile: async ({ needs }) => {
            asked.shared = needs;
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

describe("the VM size", () => {
  const sizedHarness = async () => {
    const fake = createFakeBackend();
    const asked: { targets: VmTarget[]; busy: number[]; started: Array<VmTarget | undefined> } = {
      targets: [],
      busy: [],
      started: [],
    };
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        vm: {
          ...fake.backend.vm,
          ensureRunning: async (_report, _shares, size) => {
            asked.started.push(size);
          },
          reconcile: async ({ size }, options) => {
            asked.targets.push(size);
            asked.busy.push(await options.busy());

            options.report("restarting the sandbox VM to change its size to 6 CPUs");
          },
        },
      }),
    });

    return { harness, asked };
  };

  it("asks the VM for the size vm sets with its shares, with no other launch counted as busy", async () => {
    const { harness, asked } = await sizedHarness();

    await harness.writeJson(harness.userConfigFile, { vm: { cpus: 6, memoryGiB: 8, diskGiB: 80 } });

    expect(await run([], harness.deps)).toBe(0);
    expect(asked).toEqual({
      targets: [{ cpus: 6, memoryGiB: 8, diskGiB: 80 }],
      busy: [0],
      started: [{ cpus: 6, memoryGiB: 8, diskGiB: 80 }],
    });
    expect(harness.stderr()).toContain(
      "pi-sandbox: restarting the sandbox VM to change its size to 6 CPUs\n",
    );
  });

  it("refuses a vm above what this Mac has before it starts or stops the VM", async () => {
    const { harness, asked } = await sizedHarness();

    await harness.writeJson(harness.userConfigFile, { vm: { cpus: 12, memoryGiB: 31 } });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      [
        "pi-sandbox: config: vm.cpus 12 is more than the 8 CPUs of this Mac; config: vm.memoryGiB 31 is more than the 30 GiB this Mac can give the VM (32 GiB, less 2 for macOS)",
        `  hint: lower it in ${harness.userConfigFile}, or run pi sandbox init to choose a size`,
      ].join("\n"),
    );
    expect(asked).toEqual({ targets: [], busy: [], started: [] });
  });

  it("asks with an empty target when vm is unset, and never from the doctor", async () => {
    const { harness, asked } = await sizedHarness();

    expect(await run([], harness.deps)).toBe(0);

    await run(["sandbox", "doctor"], harness.deps);

    expect(asked.targets).toEqual([{}]);
    expect(asked.started).toEqual([{}, {}]);
  });

  it("has the doctor start a stopped VM at the size vm sets, without resizing a running one", async () => {
    const { harness, asked } = await sizedHarness();

    await harness.writeJson(harness.userConfigFile, { vm: { cpus: 6 } });

    await run(["sandbox", "doctor"], harness.deps);

    expect(asked.targets).toEqual([]);
    expect(asked.started).toEqual([{ cpus: 6 }]);
  });
});

describe("the doctor and the VM", () => {
  it("starts the VM without asking for shares and never restarts it to share a path", async () => {
    const fake = createFakeBackend();
    const asked = { running: 0, shared: 0 };
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        vm: {
          ...fake.backend.vm,
          ensureRunning: async () => {
            asked.running += 1;
          },
          ensureShares: async () => {
            asked.shared += 1;
          },
        },
      }),
    });

    await run(["sandbox", "doctor"], harness.deps);

    expect(asked.running).toBe(1);
    expect(asked.shared).toBe(0);
  });
});

describe("the launch registration", () => {
  it("counts the launch from the VM stage on, leaves it out of its own share check, and ends it when a stage fails", async () => {
    const fake = createFakeBackend();
    const seen: { running?: number; busy?: number } = {};
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        vm: {
          ...fake.backend.vm,
          ensureRunning: async () => {
            seen.running = (await liveLaunches(harness.stateDir)).length;
          },
          reconcile: async (_wanted, options) => {
            seen.busy = await options.busy();

            throw new LauncherError("the share failed", "share it by hand");
          },
        },
      }),
    });

    expect(await run([], harness.deps)).toBe(1);
    expect(seen).toEqual({ running: 1, busy: 0 });
    expect(await liveLaunches(harness.stateDir)).toEqual([]);
    expect(harness.stderr()).toContain("pi-sandbox: the share failed\n  hint: share it by hand\n");
    expect(harness.stderr()).not.toContain("--no-sandbox");
  });

  it("stops after the VM stage on Ctrl-C there and ends the launch", async () => {
    const signals = new EventEmitter();
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        vm: {
          ...fake.backend.vm,
          ensureRunning: async () => {
            signals.emit("SIGINT");
          },
        },
      }),
    });

    harness.deps.signals = signals;

    expect(await run([], harness.deps)).toBe(130);
    expect(occurrences(harness.stderr(), STOPPING)).toBe(1);
    expect(piSessions(fake)).toEqual([]);
    expect(fake.containers.size).toBe(0);
    expect(await liveLaunches(harness.stateDir)).toEqual([]);
  });
});

describe("a closed output", () => {
  it("reports a closed pipe once and leaves other stream errors alone", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const closed: string[] = [];
    const failure = (code: string) => Object.assign(new Error(code), { code });

    onClosedOutput([stdout, stderr], () => closed.push("closed"));

    stdout.emit("error", failure("EPIPE"));
    stderr.emit("error", failure("EIO"));
    stdout.emit("error", failure("ERR_STREAM_DESTROYED"));

    expect(closed).toEqual(["closed"]);
    expect(() => stdout.emit("error", failure("ENOSPC"))).toThrow("ENOSPC");
  });
});

describe("pi arguments that name host files", () => {
  it("names a file argument that lies outside the folders mounted at their own path", async () => {
    const root = await realTempDir("host-paths");
    const repo = join(root, "repo");
    const outside = join(root, "notes");

    await mkdir(join(repo, "target"), { recursive: true });

    await mkdir(outside, { recursive: true });

    await Promise.all(
      [join(repo, "inside.md"), join(repo, "target", "built.md"), join(outside, "prompt.md")].map((file) =>
        writeFile(file, "text\n"),
      ),
    );

    const mounts: MountSpec[] = [
      { source: repo, target: repo, readOnly: false, kind: "bind" },
      { source: "pi-sandbox-overlay", target: join(repo, "target"), readOnly: false, kind: "volume" },
    ];
    const notices = await hostPathNotices(
      [
        "--append-system-prompt",
        join(outside, "prompt.md"),
        "--system-prompt",
        "review the diff",
        "@inside.md",
        "@target/built.md",
        "-e",
        "../notes",
        "--session",
        join(repo, "inside.md"),
      ],
      repo,
      mounts,
    );

    expect(notices).toEqual([
      `--append-system-prompt ${join(outside, "prompt.md")}: ${join(outside, "prompt.md")} lies outside the folders mounted in the sandbox, so pi inside cannot read it`,
      `@target/built.md: ${join(repo, "target", "built.md")} lies outside the folders mounted in the sandbox, so pi inside cannot read it`,
      `-e ../notes: ${outside} lies outside the folders mounted in the sandbox, so pi inside cannot read it`,
    ]);
  });
});

describe("the overlay notices", () => {
  it("says the overlays are off when the walk was cut short", () => {
    const notices = launchNotices({
      workspace: { cwd: "/work", repoRoot: "/work", isGitRepo: false, overlays: [], overlaysTruncated: true },
      effective: { config: sandboxConfig(), sources: {} },
      stateDir: "/state",
      repoHash: "r",
    });

    expect(notices).toEqual([
      "the folder is too large to search for build output; overlays disabled, the host copies are used",
    ]);
  });
});
