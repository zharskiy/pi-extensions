import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createFileCacheGuard,
  type FileCacheDeps,
  type FileCacheGuard,
  type FileCacheTick,
  fileLimitsOf,
  LSOF,
  REDISCOVER_INTERVAL_MS,
  RELEASE_COMMAND,
  SAMPLE_INTERVAL_MS,
  SYSCTL,
  type Ticker,
  watchFileCache,
} from "../../backend/colima/file-cache.ts";
import { createColimaVm } from "../../backend/colima/vm.ts";
import { stateLayout } from "../../shared/index.ts";
import { createFakeClock } from "../support/fake-clock.ts";
import { argvOf, createFakeRunner, type FakeAnswer, type FakeCall } from "../support/fake-runner.ts";
import { tempDir } from "../support/temp-dir.ts";

interface HostState {
  pids: string[];
  held?: string[];
  open: Record<string, number>;
  limits?: string;
  slow?: string[];
  gone?: string[];
}

const DISK = "/home/u/.colima/_lima/colima-pi-sandbox/disk";

const LEGACY_DISK = "/home/u/.colima/_lima/colima-pi-sandbox/diffdisk";

const missingFile = (path: string) => ({
  code: 1,
  stderr: `lsof: status error on ${path}: No such file or directory\n`,
});

const LIMIT = 30_720;

const listing = (pid: string, count: number) =>
  [`p${pid}`, ...Array.from({ length: count }, (_, index) => `f${index}`)].join("\n");

const answerHost = (host: HostState) => (call: FakeCall) => {
  if (call.file === SYSCTL) {
    return host.limits === undefined ? { stdout: "61440\n122880\n" } : { stdout: host.limits };
  }

  if (call.file !== LSOF) {
    return undefined;
  }

  const [flag, target] = call.args.slice(2);

  if (flag === "-t") {
    const path = target ?? "";

    if (!(host.held ?? [DISK]).includes(path)) {
      return missingFile(path);
    }

    return host.pids.length === 0 ? { code: 1 } : { stdout: `${host.pids.join("\n")}\n` };
  }

  const pid = target ?? "";

  if (host.slow?.includes(pid)) {
    return { code: 124, timedOut: true as const };
  }

  const count = host.open[pid];

  return count === undefined ? { code: 1 } : { stdout: `${listing(pid, count)}\n` };
};

const aliveIn = (host: HostState) => (pid: string) => !(host.gone ?? []).includes(pid);

const guardOf = (host: HostState, overrides: Partial<FileCacheDeps> = {}) => {
  const fake = createFakeRunner(answerHost(host));
  const clock = createFakeClock();
  const released: string[][] = [];
  const shell: FileCacheDeps["shell"] = async (command) => {
    released.push(command);

    Object.keys(host.open).forEach((pid) => {
      host.open[pid] = 64;
    });

    host.slow = [];

    return { code: 0, stdout: "", stderr: "" };
  };
  const guard = createFileCacheGuard({
    runner: fake.runner,
    diskPaths: [DISK],
    shell,
    lockIfFree: async (action) => ({ busy: false, value: await action() }),
    alive: aliveIn(host),
    now: clock.now,
    ...overrides,
  });

  return { guard, clock, released, calls: fake.calls };
};

const discoveries = (calls: FakeCall[]) => calls.filter((call) => call.args[2] === "-t").length;

const counted = (calls: FakeCall[]) =>
  calls.filter((call) => call.args[2] === "-p").map((call) => call.args[3]);

const deferred = <T>() => {
  const handle: { resolve: (value: T) => void } = { resolve: () => undefined };
  const promise = new Promise<T>((done) => {
    handle.resolve = done;
  });

  return { promise, resolve: (value: T) => handle.resolve(value) };
};

const manualTicker = () => {
  const queued: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];
  const ticker: Ticker = {
    after: (ms, run) => {
      const entry = { ms, run, cancelled: false };

      queued.push(entry);

      return () => {
        entry.cancelled = true;
      };
    },
  };
  const live = () => queued.filter((entry) => !entry.cancelled);
  const fire = () => {
    const next = queued.shift();

    next?.run();
  };

  return { ticker, live, fire, queued };
};

const scriptedGuard = (tick: FileCacheGuard["tick"]): FileCacheGuard => ({
  tick,
  settled: async () => undefined,
});

describe("the file limit of the Mac", () => {
  it("is half the per-process limit or a quarter of the system-wide limit, whichever is lower", () => {
    expect(fileLimitsOf("61440\n122880\n")).toEqual({ limit: LIMIT, maxFiles: 122_880 });
    expect(fileLimitsOf("10240\n122880\n")?.limit).toBe(5120);
    expect(fileLimitsOf("61440\n40000\n")?.limit).toBe(10_000);
  });

  it("is unknown when sysctl does not report both limits", () => {
    expect(fileLimitsOf("")).toBeUndefined();
    expect(fileLimitsOf("61440\n")).toBeUndefined();
    expect(fileLimitsOf("unknown oid\nx\n")).toBeUndefined();
  });

  it("is read again on each tick until a read succeeds, then kept, and nothing is released while it is unknown", async () => {
    const host: HostState = { pids: ["700"], open: { "700": 50_000 }, limits: "" };
    const { guard, calls, released } = guardOf(host);

    expect(await guard.tick()).toBe("no-limit");
    expect(released).toEqual([]);

    host.limits = "61440\n122880\n";

    expect(await guard.tick()).toBe("released");
    expect(await guard.tick()).toBe("resting");
    expect(calls.filter((call) => call.file === SYSCTL).map(argvOf)).toEqual([
      [SYSCTL, "-n", "kern.maxfilesperproc", "kern.maxfiles"],
      [SYSCTL, "-n", "kern.maxfilesperproc", "kern.maxfiles"],
    ]);
  });
});

describe("the VM process", () => {
  it("is found once through the VM's disk and counted with lsof, without name lookups", async () => {
    const { guard, calls } = guardOf({ pids: ["700"], open: { "700": 120 } });

    expect(await guard.tick()).toBe("below");
    expect(await guard.tick()).toBe("below");
    expect(calls.filter((call) => call.file === LSOF).map(argvOf)).toEqual([
      [LSOF, "-n", "-P", "-t", DISK],
      [LSOF, "-n", "-P", "-p", "700", "-F", "f"],
      [LSOF, "-n", "-P", "-p", "700", "-F", "f"],
    ]);
  });

  it("is the holder of the disk with the most open files when several hold it", async () => {
    const { guard, calls, released } = guardOf({
      pids: ["300", "700", "800"],
      open: { "300": 12, "700": 50_000, "800": 40 },
    });

    expect(await guard.tick()).toBe("released");
    expect(released).toHaveLength(1);

    await guard.tick();

    expect(counted(calls).slice(0, 3).sort()).toEqual(["300", "700", "800"]);
    expect(counted(calls).at(-1)).toBe("700");
  });

  it("is found again when the cached process is gone, as after a VM restart", async () => {
    const host: HostState = { pids: ["700"], open: { "700": 120 } };
    const { guard, calls } = guardOf(host);

    await guard.tick();

    host.pids = ["900"];
    host.open = { "900": 140 };

    expect(await guard.tick()).toBe("below");
    expect(discoveries(calls)).toBe(2);
    expect(counted(calls).at(-1)).toBe("900");
  });

  it("is found again every 5 minutes, so a wrong process found first does not switch the release off", async () => {
    const host: HostState = { pids: ["300"], open: { "300": 12, "700": 50_000 } };
    const { guard, clock, calls, released } = guardOf(host);

    expect(await guard.tick()).toBe("below");

    host.pids = ["300", "700"];

    clock.advance(REDISCOVER_INTERVAL_MS - 1);

    expect(await guard.tick()).toBe("below");
    expect(discoveries(calls)).toBe(1);

    clock.advance(1);

    expect(await guard.tick()).toBe("released");
    expect(discoveries(calls)).toBe(2);
    expect(released).toHaveLength(1);
  });

  it("is found through whichever disk name the instance has, one lsof per name", async () => {
    const host: HostState = { pids: ["700"], held: [LEGACY_DISK], open: { "700": 120 } };
    const { guard, calls } = guardOf(host, { diskPaths: [DISK, LEGACY_DISK] });

    expect(await guard.tick()).toBe("below");
    expect(calls.filter((call) => call.args[2] === "-t").map(argvOf)).toEqual([
      [LSOF, "-n", "-P", "-t", DISK],
      [LSOF, "-n", "-P", "-t", LEGACY_DISK],
    ]);
    expect(counted(calls)).toEqual(["700"]);
  });

  it("is counted once when it holds several of the disks", async () => {
    const host: HostState = { pids: ["700"], held: [DISK, LEGACY_DISK], open: { "700": 120 } };
    const { guard, calls } = guardOf(host, { diskPaths: [DISK, LEGACY_DISK] });

    expect(await guard.tick()).toBe("below");
    expect(counted(calls)).toEqual(["700"]);
  });

  it("does nothing when no process holds the VM's disk", async () => {
    const { guard, released, calls } = guardOf({ pids: [], open: {} });

    expect(await guard.tick()).toBe("no-vm");
    expect(await guard.tick()).toBe("no-vm");
    expect(released).toEqual([]);
    expect(calls.every((call) => call.file === LSOF && call.args[2] === "-t")).toBe(true);
  });

  it("does nothing when lsof cannot run", async () => {
    const fake = createFakeRunner(() => undefined);
    const guard = createFileCacheGuard({
      runner: fake.runner,
      diskPaths: [DISK],
      shell: async () => {
        throw new Error("never");
      },
      lockIfFree: async () => ({ busy: true }),
      alive: () => true,
      now: Date.now,
    });

    expect(await guard.tick()).toBe("no-vm");
  });
});

describe("a count that times out", () => {
  it("counts as past the limit while the process lives, so the cache is released", async () => {
    const host: HostState = { pids: ["700"], open: { "700": 120 } };
    const { guard, released, calls } = guardOf(host);

    expect(await guard.tick()).toBe("below");

    host.slow = ["700"];

    expect(await guard.tick()).toBe("released");
    expect(released).toEqual([RELEASE_COMMAND]);
    expect(discoveries(calls)).toBe(1);
  });

  it("leads to the process being found again when it is gone", async () => {
    const host: HostState = { pids: ["700"], open: { "700": 120 } };
    const { guard, released, calls } = guardOf(host);

    await guard.tick();

    host.slow = ["700"];
    host.gone = ["700"];
    host.pids = ["900"];
    host.open = { "900": 140 };

    expect(await guard.tick()).toBe("below");
    expect(discoveries(calls)).toBe(2);
    expect(released).toEqual([]);
  });
});

describe("the file cache reading", () => {
  it("reports the count, the limit and kern.maxfiles, and releases nothing", async () => {
    const { guard, released, calls } = guardOf({ pids: ["700"], open: { "700": 50_000 } });

    expect(await guard.read()).toEqual({ state: "counted", count: 50_000, limit: LIMIT, maxFiles: 122_880 });
    expect(released).toEqual([]);
    expect(calls.every((call) => call.file === LSOF || call.file === SYSCTL)).toBe(true);
  });

  it("reports the paths it looked for when no process holds them", async () => {
    const { guard } = guardOf({ pids: [], held: [], open: {} }, { diskPaths: [DISK, LEGACY_DISK] });

    expect(await guard.read()).toEqual({ state: "no-vm", looked: [DISK, LEGACY_DISK] });
  });

  it("reports a count that times out on a live process as timed out", async () => {
    const { guard } = guardOf({ pids: ["700"], open: {}, slow: ["700"] });

    expect(await guard.read()).toMatchObject({ state: "counted", count: "timed out" });
  });

  it("reports the count without a limit when sysctl does not answer", async () => {
    const { guard } = guardOf({ pids: ["700"], open: { "700": 120 }, limits: "" });

    expect(await guard.read()).toEqual({ state: "no-limit", count: 120 });
  });
});

describe("the file cache release", () => {
  it("runs only the fixed drop_caches command once the count reaches the limit", async () => {
    const host = { pids: ["700"], open: { "700": LIMIT - 1 } };
    const { guard, released } = guardOf(host);

    expect(await guard.tick()).toBe("below");

    host.open["700"] = LIMIT;

    expect(await guard.tick()).toBe("released");
    expect(released).toEqual([["sudo", "sysctl", "-q", "-w", "vm.drop_caches=2"]]);
    expect(RELEASE_COMMAND).toEqual(["sudo", "sysctl", "-q", "-w", "vm.drop_caches=2"]);
  });

  it("releases at most once per 30 seconds", async () => {
    const host = { pids: ["700"], open: { "700": 50_000 } };
    const { guard, clock, released } = guardOf(host);

    expect(await guard.tick()).toBe("released");

    host.open["700"] = 50_000;

    clock.advance(29_999);

    expect(await guard.tick()).toBe("resting");

    clock.advance(1);

    expect(await guard.tick()).toBe("released");
    expect(released).toHaveLength(2);
  });

  it("waits out the interval after a failed release too", async () => {
    const host = { pids: ["700"], open: { "700": 50_000 } };
    const { guard } = guardOf(host, {
      shell: async () => ({ code: 255, stdout: "", stderr: "ssh refused" }),
    });

    expect(await guard.tick()).toBe("failed");
    expect(await guard.tick()).toBe("resting");
  });

  it("skips the tick when the VM lock is busy, and samples again on the next", async () => {
    const host = { pids: ["700"], open: { "700": 50_000 } };
    const lock = { busy: true };
    const { guard, released } = guardOf(host, {
      lockIfFree: async (action) => (lock.busy ? { busy: true } : { busy: false, value: await action() }),
    });

    expect(await guard.tick()).toBe("busy");
    expect(released).toEqual([]);

    lock.busy = false;

    expect(await guard.tick()).toBe("released");
  });

  it("counts again under the lock, so a session that finds the cache released by another does not release it", async () => {
    const host = { pids: ["700"], open: { "700": 50_000 } };
    const { guard, released } = guardOf(host, {
      lockIfFree: async (action) => {
        host.open["700"] = 80;

        return { busy: false, value: await action() };
      },
    });

    expect(await guard.tick()).toBe("below");
    expect(released).toEqual([]);
  });

  it("releases when the count under the lock times out on a live process", async () => {
    const host: HostState = { pids: ["700"], open: { "700": 50_000 } };
    const { guard, released } = guardOf(host, {
      lockIfFree: async (action) => {
        host.slow = ["700"];

        return { busy: false, value: await action() };
      },
    });

    expect(await guard.tick()).toBe("released");
    expect(released).toHaveLength(1);
  });
});

describe("the file cache watch", () => {
  it("samples every 10 seconds until stopped, and schedules nothing after a tick that ends after stop", async () => {
    const ticks: Array<(outcome: FileCacheTick) => void> = [];
    const { ticker, live, fire, queued } = manualTicker();
    const watch = watchFileCache(
      scriptedGuard(() => new Promise((done) => ticks.push(done))),
      ticker,
    );

    expect(queued.map((entry) => entry.ms)).toEqual([SAMPLE_INTERVAL_MS]);

    fire();

    ticks.shift()?.("below");

    await vi.waitFor(() => expect(live()).toHaveLength(1));

    fire();

    await watch.stop();

    ticks.shift()?.("below");

    await new Promise((done) => setTimeout(done, 20));

    expect(live()).toEqual([]);
    expect(queued).toEqual([]);
  });

  it("cancels the pending sample when stopped between ticks", async () => {
    const { ticker, live } = manualTicker();
    const watch = watchFileCache(
      scriptedGuard(async () => "below"),
      ticker,
    );

    expect(live()).toHaveLength(1);

    await watch.stop();

    expect(live()).toEqual([]);
  });

  it("keeps sampling after a tick that throws", async () => {
    const { ticker, live, fire } = manualTicker();

    watchFileCache(
      scriptedGuard(async () => {
        throw new Error("lsof vanished");
      }),
      ticker,
    );

    fire();

    await vi.waitFor(() => expect(live()).toHaveLength(1));
  });
});

describe("the colima VM's file cache watch", () => {
  const setup = async (respond: (call: FakeCall) => FakeAnswer | Promise<FakeAnswer> = () => ({})) => {
    const home = await tempDir("file-cache");
    const host: HostState = {
      pids: ["700"],
      held: [join(home, ".colima", "_lima", "colima-pi-sandbox", "disk")],
      open: { "700": 50_000 },
    };
    const answer = answerHost(host);
    const fake = createFakeRunner((call) => (call.file === "colima" ? respond(call) : answer(call)));
    const { ticker, fire } = manualTicker();
    const vm = createColimaVm({
      home,
      stateDir: home,
      runner: fake.runner,
      detect: async () => ({ available: true }),
      ticker,
    });
    const colimaCalls = () => fake.calls.filter((call) => call.file === "colima").map((call) => call.args);
    const lockGone = () =>
      access(stateLayout(home).vmLock).then(
        () => false,
        () => true,
      );

    return { home, vm, fire, fake, colimaCalls, lockGone };
  };

  it("finds the VM process by the profile's disk and releases through colima ssh as root", async () => {
    const { home, vm, fire, fake, colimaCalls } = await setup();
    const watch = vm.watchFileCache?.();

    fire();

    await vi.waitFor(() => expect(colimaCalls()).toHaveLength(1));

    await watch?.stop();

    expect(fake.calls.slice(0, 3).map((call) => call.args)).toEqual(
      [
        join(home, ".colima", "_lima", "colima-pi-sandbox", "disk"),
        join(home, ".colima", "_lima", "colima-pi-sandbox", "diffdisk"),
        join(home, ".colima", "_lima", "_disks", "colima-pi-sandbox", "datadisk"),
      ].map((path) => ["-n", "-P", "-t", path]),
    );
    expect(colimaCalls()).toEqual([
      ["ssh", "--profile", "pi-sandbox", "--", "sudo", "sysctl", "-q", "-w", "vm.drop_caches=2"],
    ]);
    expect(fake.calls.find((call) => call.file === "colima")?.options.env).toEqual({
      COLIMA_HOME: join(home, ".colima"),
    });
  });

  it("does not wait for the VM lock while a launch holds it", async () => {
    const { home, vm, fire, fake, colimaCalls } = await setup();

    await mkdir(stateLayout(home).vmLock, { recursive: true });

    const watch = vm.watchFileCache?.();

    fire();

    await vi.waitFor(() => expect(fake.calls.filter((call) => call.file === SYSCTL)).toHaveLength(1));

    await new Promise((done) => setTimeout(done, 50));

    await watch?.stop();

    expect(colimaCalls()).toEqual([]);
  });

  it("waits on stop for a release under way to finish and its lock to be removed", async () => {
    const ssh = deferred<FakeAnswer>();
    const { vm, fire, colimaCalls, lockGone } = await setup(() => ssh.promise);
    const watch = vm.watchFileCache?.();

    fire();

    await vi.waitFor(() => expect(colimaCalls()).toHaveLength(1));

    expect(await lockGone()).toBe(false);

    const stopped = { now: false };
    const stopping = watch?.stop().then(() => {
      stopped.now = true;
    });

    await new Promise((done) => setTimeout(done, 20));

    expect(stopped.now).toBe(false);

    ssh.resolve({});

    await stopping;

    expect(await lockGone()).toBe(true);
  });

  it("returns at once from a stop during a sample, and releases nothing after it", async () => {
    const home = await tempDir("file-cache");
    const lsof = deferred<FakeAnswer>();
    const fake = createFakeRunner((call) => {
      if (call.file === LSOF && call.args[2] === "-t") {
        return lsof.promise;
      }

      return answerHost({ pids: ["700"], open: { "700": 50_000 } })(call) ?? {};
    });
    const { ticker, fire, live } = manualTicker();
    const vm = createColimaVm({
      home,
      stateDir: home,
      runner: fake.runner,
      detect: async () => ({ available: true }),
      ticker,
    });
    const watch = vm.watchFileCache?.();

    fire();

    await vi.waitFor(() => expect(fake.calls).toHaveLength(3));

    await watch?.stop();

    lsof.resolve({ stdout: "700\n" });

    await vi.waitFor(() => expect(fake.calls.filter((call) => call.file === SYSCTL)).toHaveLength(1));

    await new Promise((done) => setTimeout(done, 20));

    expect(fake.calls.filter((call) => call.file === "colima")).toEqual([]);
    expect(live()).toEqual([]);
  });
});
