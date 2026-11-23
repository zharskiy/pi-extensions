import type { CommandRunner, LockOutcome, RunResult } from "../../shared/index.ts";
import type { VmFileCache, VmWatch } from "../types.ts";

export const LSOF = "/usr/sbin/lsof";

export const SYSCTL = "/usr/sbin/sysctl";

export const RELEASE_COMMAND = ["sudo", "sysctl", "-q", "-w", "vm.drop_caches=2"];

export const SAMPLE_INTERVAL_MS = 10_000;

export const REDISCOVER_INTERVAL_MS = 5 * 60_000;

const RELEASE_INTERVAL_MS = 30_000;

const PROBE_TIMEOUT_MS = 10_000;

const RELEASE_TIMEOUT_MS = 30_000;

const PAST_THE_LIMIT = Number.POSITIVE_INFINITY;

export type FileCacheTick =
  | "no-vm"
  | "no-limit"
  | "below"
  | "resting"
  | "busy"
  | "released"
  | "failed"
  | "stopped";

export interface FileCacheDeps {
  runner: CommandRunner;
  diskPaths: string[];
  shell: (command: string[], options: { timeoutMs: number }) => Promise<RunResult>;
  lockIfFree: (action: () => Promise<FileCacheTick>) => Promise<LockOutcome<FileCacheTick>>;
  alive: (pid: string) => boolean;
  now: () => number;
}

export interface FileCacheGuard {
  tick(active?: () => boolean): Promise<FileCacheTick>;
  settled(): Promise<void>;
}

interface FileLimits {
  limit: number;
  maxFiles: number;
}

export interface Ticker {
  after(ms: number, run: () => void): () => void;
}

interface Holder {
  pid: string;
  count: number;
}

const realTicker: Ticker = {
  after: (ms, run) => {
    const timer = setTimeout(run, ms);

    timer.unref();

    return () => clearTimeout(timer);
  },
};

export const processAlive = (pid: string) => {
  try {
    process.kill(Number(pid), 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const fileLimitsOf = (stdout: string): FileLimits | undefined => {
  const [perProcess, total] = stdout.trim().split("\n").map(Number);

  if (perProcess === undefined || total === undefined || !(perProcess > 0) || !(total > 0)) {
    return undefined;
  }

  return { limit: Math.min(Math.floor(perProcess / 2), Math.floor(total / 4)), maxFiles: total };
};

const busiest = (holders: Holder[]) =>
  holders.reduce<Holder | undefined>(
    (best, holder) => (best === undefined || holder.count > best.count ? holder : best),
    undefined,
  );

export const createFileCacheGuard = (deps: FileCacheDeps) => {
  const state: {
    pid?: string;
    foundAt?: number;
    limits?: FileLimits;
    releasedAt?: number;
    locking?: Promise<unknown>;
  } = {};

  const probe = (args: string[]) =>
    deps.runner.run(LSOF, ["-n", "-P", ...args], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined);

  const countOf = async (pid: string) => {
    const listed = await probe(["-p", pid, "-F", "f"]);

    if (listed?.code === 0) {
      return listed.stdout.split("\n").filter((line) => line.startsWith("f")).length;
    }

    return listed?.timedOut === true && deps.alive(pid) ? PAST_THE_LIMIT : undefined;
  };

  const holdersOf = async (diskPath: string) => {
    const found = await probe(["-t", diskPath]);

    if (found === undefined || found.timedOut === true) {
      return undefined;
    }

    return found.code === 0 ? found.stdout.split("\n").map((line) => line.trim()) : [];
  };

  const knownHolder = async (): Promise<Holder | undefined> => {
    const pid = state.pid;

    if (pid === undefined || !deps.alive(pid)) {
      return undefined;
    }

    const count = await countOf(pid);

    return count === undefined ? undefined : { pid, count };
  };

  const discover = async () => {
    const lookups = await Promise.all(deps.diskPaths.map(holdersOf));
    const pids = [...new Set(lookups.flatMap((holders) => holders ?? []))];
    const counted = await Promise.all(
      pids.filter((pid) => /^\d+$/.test(pid)).map(async (pid) => ({ pid, count: await countOf(pid) })),
    );
    const found = busiest(counted.filter((entry): entry is Holder => entry.count !== undefined));
    const lookupFailed = lookups.includes(undefined);
    const holder = found ?? (lookupFailed ? await knownHolder() : undefined);

    state.pid = holder?.pid;
    state.foundAt = deps.now();

    return { holder, lookupFailed };
  };

  const sample = async () => {
    const cached = state.pid;
    const fresh = state.foundAt !== undefined && deps.now() - state.foundAt < REDISCOVER_INTERVAL_MS;
    const count = cached !== undefined && fresh ? await countOf(cached) : undefined;

    if (count !== undefined) {
      return count;
    }

    return (await discover()).holder?.count;
  };

  const readLimits = async () => {
    if (state.limits === undefined) {
      const read = await deps.runner
        .run(SYSCTL, ["-n", "kern.maxfilesperproc", "kern.maxfiles"], { timeoutMs: PROBE_TIMEOUT_MS })
        .catch(() => undefined);

      state.limits = read?.code === 0 ? fileLimitsOf(read.stdout) : undefined;
    }

    return state.limits;
  };

  const release = async (limit: number, active: () => boolean): Promise<FileCacheTick> => {
    if (!active()) {
      return "stopped";
    }

    const count = await sample();

    if (count === undefined || count < limit) {
      return "below";
    }

    if (!active()) {
      return "stopped";
    }

    state.releasedAt = deps.now();

    const result = await deps
      .shell(RELEASE_COMMAND, { timeoutMs: RELEASE_TIMEOUT_MS })
      .catch(() => undefined);

    return result?.code === 0 ? "released" : "failed";
  };

  const locked = async (limit: number, active: () => boolean) => {
    const locking = deps.lockIfFree(() => release(limit, active));

    state.locking = locking.catch(() => undefined);

    try {
      const outcome = await locking;

      return outcome.busy ? "busy" : outcome.value;
    } finally {
      state.locking = undefined;
    }
  };

  const tick = async (active: () => boolean = () => true): Promise<FileCacheTick> => {
    const releasedAt = state.releasedAt;

    if (releasedAt !== undefined && deps.now() - releasedAt < RELEASE_INTERVAL_MS) {
      return "resting";
    }

    const count = await sample();

    if (count === undefined) {
      return "no-vm";
    }

    const limit = (await readLimits())?.limit;

    if (limit === undefined) {
      return "no-limit";
    }

    if (count < limit) {
      return "below";
    }

    if (!active()) {
      return "stopped";
    }

    return locked(limit, active);
  };

  const settled = async () => {
    await state.locking;
  };

  const read = async (): Promise<VmFileCache> => {
    const { holder, lookupFailed } = await discover();

    if (holder === undefined) {
      return lookupFailed
        ? { state: "lookup-failed", looked: deps.diskPaths }
        : { state: "no-vm", looked: deps.diskPaths };
    }

    const count = holder.count === PAST_THE_LIMIT ? "timed out" : holder.count;
    const limits = await readLimits();

    return limits === undefined ? { state: "no-limit", count } : { state: "counted", count, ...limits };
  };

  return { tick, settled, read };
};

export const watchFileCache = (guard: FileCacheGuard, ticker: Ticker = realTicker): VmWatch => {
  const state: { stopped: boolean; cancel?: () => void } = { stopped: false };
  const active = () => !state.stopped;

  const schedule = () => {
    if (state.stopped) {
      return;
    }

    state.cancel = ticker.after(SAMPLE_INTERVAL_MS, () => {
      void guard
        .tick(active)
        .catch(() => undefined)
        .then(schedule);
    });
  };

  schedule();

  const stop = () => {
    state.stopped = true;

    state.cancel?.();

    return guard.settled();
  };

  return { stop };
};
