import type { CommandRunner, LockOutcome, RunResult } from "../../shared/index.ts";
import type { VmWatch } from "../types.ts";

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
  diskPath: string;
  shell: (command: string[], options: { timeoutMs: number }) => Promise<RunResult>;
  lockIfFree: (action: () => Promise<FileCacheTick>) => Promise<LockOutcome<FileCacheTick>>;
  alive: (pid: string) => boolean;
  now: () => number;
}

export interface FileCacheGuard {
  tick(active?: () => boolean): Promise<FileCacheTick>;
  settled(): Promise<void>;
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

export const fileLimitOf = (stdout: string) => {
  const [perProcess, total] = stdout.trim().split("\n").map(Number);

  if (perProcess === undefined || total === undefined || !(perProcess > 0) || !(total > 0)) {
    return undefined;
  }

  return Math.min(Math.floor(perProcess / 2), Math.floor(total / 4));
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
    limit?: number;
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

  const discover = async () => {
    const found = await probe(["-t", deps.diskPath]);
    const pids = found?.code === 0 ? found.stdout.split("\n").map((line) => line.trim()) : [];
    const counted = await Promise.all(
      pids.filter((pid) => /^\d+$/.test(pid)).map(async (pid) => ({ pid, count: await countOf(pid) })),
    );
    const holder = busiest(counted.filter((entry): entry is Holder => entry.count !== undefined));

    state.pid = holder?.pid;
    state.foundAt = deps.now();

    return holder;
  };

  const sample = async () => {
    const cached = state.pid;
    const fresh = state.foundAt !== undefined && deps.now() - state.foundAt < REDISCOVER_INTERVAL_MS;
    const count = cached !== undefined && fresh ? await countOf(cached) : undefined;

    if (count !== undefined) {
      return count;
    }

    return (await discover())?.count;
  };

  const readLimit = async () => {
    if (state.limit === undefined) {
      const read = await deps.runner
        .run(SYSCTL, ["-n", "kern.maxfilesperproc", "kern.maxfiles"], { timeoutMs: PROBE_TIMEOUT_MS })
        .catch(() => undefined);

      state.limit = read?.code === 0 ? fileLimitOf(read.stdout) : undefined;
    }

    return state.limit;
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

    const limit = await readLimit();

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

  return { tick, settled, discover, countOf };
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
