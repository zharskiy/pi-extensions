import { EventEmitter } from "node:events";
import { lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { Backend, MountSpec, VmPath, VmTarget } from "../../backend/index.ts";
import { onClosedOutput } from "../../cli/deps.ts";
import { CLEANUP_WAITING, GROUND_WAITING, withGroundLock } from "../../cli/ground.ts";
import { run, runPinata } from "../../cli/index.ts";
import { hostPathNotices, projectSkillLinkNotices } from "../../cli/launch-notices.ts";
import { liveLaunches } from "../../grants/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { hostSessionsDir } from "../../workspace/index.ts";
import { tempDir } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness, piSessions, renderDirOf } from "./harness.ts";

const STOPPING = "pinata: stopping after the current step\n";

const SKIPPING_WAITS =
  "pinata: the cleanup will not wait for other pinata commands; another Ctrl-C ends pinata at once, leaving the rest to the next start\n";

const PREPARATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

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
  it("says once that it stops after the current step, catches a second signal while the step unwinds, then leaves the next to the default handler", async () => {
    const signals = new EventEmitter();
    const fake = createFakeBackend();
    const counts: number[] = [];
    const listening = () => PREPARATION_SIGNALS.map((name) => signals.listenerCount(name));
    const backend: Backend = {
      ...fake.backend,
      buildImage: async (...args: Parameters<Backend["buildImage"]>) => {
        if (counts.length > 0) {
          return fake.backend.buildImage(...args);
        }

        counts.push(...listening());

        signals.emit("SIGINT");

        await sleep(20);

        counts.push(...listening());

        signals.emit("SIGTERM");

        counts.push(...listening());

        return fake.backend.buildImage(...args);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    harness.deps.signals = signals;

    expect(await run([], harness.deps)).toBe(130);
    expect(counts).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 0]);
    expect(occurrences(harness.stderr(), STOPPING)).toBe(1);
    expect(occurrences(harness.stderr(), SKIPPING_WAITS)).toBe(1);
    expect(piSessions(fake)).toEqual([]);
    expect(fake.containers.size).toBe(0);
    expect(await liveLaunches(harness.stateDir)).toEqual([]);
  });

  it("leaves signals to the default handler while pi runs", async () => {
    const signals = new EventEmitter();
    const fake = createFakeBackend();
    const counts: number[] = [];
    const backend: Backend = {
      ...fake.backend,
      exec: async (spec, io) => {
        if (spec.env.PINATA_LAUNCH_ID !== undefined) {
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

  it("catches a signal while the session ends, so the cleanup finishes, and leaves the next to the default handler", async () => {
    const signals = new EventEmitter();
    const fake = createFakeBackend();
    const counts: number[] = [];
    const listening = () => PREPARATION_SIGNALS.map((name) => signals.listenerCount(name));
    const backend: Backend = {
      ...fake.backend,
      stopContainer: async (id: string, timeoutSeconds?: number) => {
        counts.push(...listening());

        signals.emit("SIGHUP");

        counts.push(...listening());

        return fake.backend.stopContainer(id, timeoutSeconds);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    harness.deps.signals = signals;

    expect(await run([], harness.deps)).toBe(0);
    expect(counts).toEqual([1, 1, 1, 0, 0, 0]);
    expect(occurrences(harness.stderr(), SKIPPING_WAITS)).toBe(1);
    expect(fake.containers.size).toBe(0);
    expect(await liveLaunches(harness.stateDir)).toEqual([]);
  });
  it("ends the waits for the ground lock on Ctrl-C, and the cleanup wait at the end of the session on a second Ctrl-C", async () => {
    const signals = new EventEmitter();
    const harness = await createHarness({ backend: () => createFakeBackend().backend });
    const holder = { entered: (): void => undefined, release: (): void => undefined };
    const entered = new Promise<void>((resolve) => {
      holder.entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      holder.release = resolve;
    });
    const holding = withGroundLock({ stateDir: harness.stateDir }, () => {
      holder.entered();

      return released;
    });

    harness.deps.signals = signals;

    await entered;

    const code = run([], harness.deps);

    await waitFor(() => occurrences(harness.stderr(), GROUND_WAITING) >= 2);

    signals.emit("SIGINT");

    await waitFor(() => harness.stderr().includes(CLEANUP_WAITING));

    expect(harness.stderr()).toContain(`${CLEANUP_WAITING}; Ctrl-C skips the cleanup\n`);

    signals.emit("SIGINT");

    const outcome = await Promise.race([code, sleep(3000).then(() => "still waiting")]);

    holder.release();

    await holding;

    await code;

    expect(outcome).toBe(130);
    expect(occurrences(harness.stderr(), SKIPPING_WAITS)).toBe(1);
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
    expect(seen).toEqual([true, true]);
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
            caCertPath: harness.proxyCaPem,
            extraPemPath: join(harness.stateDir, "ca", "extra.pem"),
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
            asked.busy.push((await options.busy()).count);

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
    expect(harness.stderr()).toContain("pinata: restarting the sandbox VM to change its size to 6 CPUs\n");
  });

  it("refuses a vm above what this Mac has before it starts or stops the VM", async () => {
    const { harness, asked } = await sizedHarness();

    await harness.writeJson(harness.userConfigFile, { vm: { cpus: 12, memoryGiB: 31 } });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      [
        "pinata: config: vm.cpus 12 is more than the 8 CPUs of this Mac; config: vm.memoryGiB 31 is more than the 30 GiB this Mac can give the VM (32 GiB, less 2 for macOS)",
        `  hint: lower it in ${harness.userConfigFile}, or run pinata init to choose a size`,
      ].join("\n"),
    );
    expect(asked).toEqual({ targets: [], busy: [], started: [] });
  });

  it("counts the agent's and the services' memory against the automatic VM size when vm.memoryGiB is unset", async () => {
    const { harness, asked } = await sizedHarness();
    const services = [{ name: "db", command: ["db"], memoryGiB: 4 }];

    await harness.writeJson(harness.userConfigFile, { resources: { memoryGiB: 7 }, services });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      [
        "pinata: config: resources.memoryGiB 7 plus the services' memoryGiB 4 is larger than the 10 GiB the VM gets by default on this Mac (vm.memoryGiB is not set); the agent and every service share the VM",
        `  hint: set vm.memoryGiB in ${harness.userConfigFile}, or run pinata init to choose a size`,
      ].join("\n"),
    );
    expect(asked).toEqual({ targets: [], busy: [], started: [] });
  });

  it("asks with an empty target when vm is unset, and never from the doctor", async () => {
    const { harness, asked } = await sizedHarness();

    expect(await run([], harness.deps)).toBe(0);

    await runPinata(["doctor"], harness.deps);

    expect(asked.targets).toEqual([{}]);
    expect(asked.started).toEqual([{}, {}]);
  });

  it("has the doctor start a stopped VM at the size vm sets, without resizing a running one", async () => {
    const { harness, asked } = await sizedHarness();

    await harness.writeJson(harness.userConfigFile, { vm: { cpus: 6 } });

    await runPinata(["doctor"], harness.deps);

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

    await runPinata(["doctor"], harness.deps);

    expect(asked.running).toBe(1);
    expect(asked.shared).toBe(0);
  });

  it("does not watch the VM's file cache, even with vm.releaseFileCache on", async () => {
    const watched: string[] = [];
    const fake = createFakeBackend({
      vm: {
        ensureRunning: async () => {
          watched.push("running");
        },
        watchFileCache: () => {
          watched.push("watch");

          return { stop: async () => undefined };
        },
      },
    });
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, { vm: { releaseFileCache: true } });

    await runPinata(["doctor"], harness.deps);

    expect(watched).toEqual(["running"]);
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
            seen.busy = (await options.busy()).count;

            throw new LauncherError("the share failed", "share it by hand");
          },
        },
      }),
    });

    expect(await run([], harness.deps)).toBe(1);
    expect(seen).toEqual({ running: 1, busy: 0 });
    expect(await liveLaunches(harness.stateDir)).toEqual([]);
    expect(harness.stderr()).toContain("pinata: the share failed\n  hint: share it by hand\n");
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
    const root = await realpath(await tempDir("host-paths"));
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
      { source: "pinata-volume", target: join(repo, "target"), readOnly: false, kind: "volume" },
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

describe("project skill links", () => {
  it("names the links of the project skill folders whose targets the sandbox cannot see", async () => {
    const root = await realpath(await tempDir("skill-links"));
    const repo = join(root, "repo");
    const cwd = join(repo, "src");
    const dotfiles = join(root, "dotfiles");
    const reference = join(root, "reference");

    await Promise.all(
      [
        join(cwd, ".pi", "skills"),
        join(repo, ".agents", "skills"),
        join(repo, "shared", "bar"),
        join(dotfiles, "foo"),
        join(dotfiles, "skills"),
        join(reference, "baz"),
        join(root, ".agents", "skills"),
      ].map((dir) => mkdir(dir, { recursive: true })),
    );

    await symlink(join(dotfiles, "foo"), join(cwd, ".pi", "skills", "foo"));

    await mkdir(join(cwd, ".agents"));

    await symlink(join(dotfiles, "skills"), join(cwd, ".agents", "skills"));

    await symlink(join(repo, "shared", "bar"), join(repo, ".agents", "skills", "bar"));

    await symlink(join(root, "missing"), join(repo, ".agents", "skills", "gone"));

    await symlink(join(reference, "baz"), join(repo, ".agents", "skills", "baz"));

    await symlink(join(dotfiles, "foo"), join(root, ".agents", "skills", "above"));

    const mounts: MountSpec[] = [
      { source: repo, target: repo, readOnly: false, kind: "bind" },
      { source: reference, target: reference, readOnly: true, kind: "bind" },
    ];

    expect(await projectSkillLinkNotices(cwd, repo, mounts)).toEqual([
      `project skills: links that dangle in the sandbox, because their targets lie outside the folders it mounts: .pi/skills/foo -> ${join(dotfiles, "foo")}, .agents/skills -> ${join(dotfiles, "skills")}; move each target inside the workspace root, or bind its folder read-only at the same absolute path with mounts.binds in the user config`,
    ]);
    expect(await projectSkillLinkNotices(repo, repo, mounts)).toEqual([]);
  });
});
