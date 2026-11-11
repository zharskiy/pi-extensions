import { randomBytes } from "node:crypto";
import { link, mkdir, open, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage, LauncherError } from "./errors.ts";
import { isLive, isRunning, processMark } from "./liveness.ts";

export interface FileLockOptions {
  staleMs?: number;
  timeoutMs?: number;
  retryMs?: number;
}

interface LockSettings {
  staleMs?: number;
  retryMs: number;
  deadline: number;
  held?: string;
}

interface LockSnapshot {
  owner: number;
  boot: number;
  start: string;
  mark: string;
  mtimeMs: number;
}

const DEFAULT_STALE_MS = 10_000;

const DEFAULT_TIMEOUT_MS = 10_000;

const DEFAULT_RETRY_MS = 25;

const DIRECTORY_REFRESH_MS = 1_000;

const PRIVATE_MODE = 0o600;

const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException).code === code;

const settingsOf = (options: FileLockOptions, byAge: boolean): LockSettings => ({
  staleMs: byAge ? (options.staleMs ?? DEFAULT_STALE_MS) : undefined,
  retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
  deadline: Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
});

const sibling = (path: string, kind: string) =>
  `${path}.${kind}.${process.pid}.${randomBytes(4).toString("hex")}`;

const snapshotOf = async (path: string): Promise<LockSnapshot | undefined> => {
  const info = await stat(path).catch(() => undefined);

  if (info === undefined) {
    return undefined;
  }

  const handle = info.isFile() ? await open(path, "r").catch(() => undefined) : undefined;
  const text = (await handle?.readFile("utf8").catch(() => "")) ?? "";
  const mark = info.isFile() ? `${info.ino}:${text}` : `${info.ino}:${info.birthtimeMs}`;

  const [owner = "", boot = "", start = ""] = text.split(" ");

  await handle?.close();

  return { owner: Number.parseInt(owner, 10), boot: Number(boot), start, mark, mtimeMs: info.mtimeMs };
};

const isHeld = async (snapshot: LockSnapshot, staleMs: number | undefined) =>
  staleMs === undefined
    ? isLive({ pid: snapshot.owner, boot: snapshot.boot, start: snapshot.start })
    : Date.now() - snapshot.mtimeMs <= staleMs;

const stillHeld = async (snapshot: LockSnapshot, settings: LockSettings) =>
  (settings.staleMs === undefined && snapshot.mark === settings.held && isRunning(snapshot.owner)) ||
  isHeld(snapshot, settings.staleMs);

const sameLock = (left: LockSnapshot | undefined, right: LockSnapshot) =>
  left !== undefined && left.mark === right.mark && left.mtimeMs === right.mtimeMs;

const restore = async (moved: string, path: string) => {
  await link(moved, path).catch(async () => {
    const taken = await stat(path).then(
      () => true,
      () => false,
    );

    if (!taken) {
      await rename(moved, path).catch(() => undefined);
    }
  });
};

const moveAside = async (path: string, stale: LockSnapshot, staleMs: number | undefined) => {
  const moved = sibling(path, "stale");
  const renamed = await rename(path, moved).then(
    () => true,
    () => false,
  );

  if (!renamed) {
    return;
  }

  const found = await snapshotOf(moved);

  if (found !== undefined && !sameLock(found, stale) && (await isHeld(found, staleMs))) {
    await restore(moved, path);
  }

  await rm(moved, { recursive: true, force: true });
};

const clearDeadGuard = async (guard: string) => {
  const snapshot = await snapshotOf(guard);

  if (snapshot !== undefined && !(await isHeld(snapshot, undefined))) {
    await moveAside(guard, snapshot, undefined);
  }
};

const takeOver = async (
  path: string,
  stale: LockSnapshot,
  staleMs: number | undefined,
  retried = false,
): Promise<boolean> => {
  const guard = `${path}.takeover`;
  const mark = await createPidLock(guard);

  if (mark === undefined) {
    await clearDeadGuard(guard);

    return retried ? false : takeOver(path, stale, staleMs, true);
  }

  try {
    const current = await snapshotOf(path);

    if (current !== undefined && sameLock(current, stale) && !(await isHeld(current, staleMs))) {
      await moveAside(path, stale, staleMs);
    }

    return true;
  } finally {
    await release(guard, mark);
  }
};

class LockBusy extends LauncherError {}

const busy = (path: string, snapshot: LockSnapshot | undefined) => {
  const owner = snapshot !== undefined && Number.isInteger(snapshot.owner) ? ` (pid ${snapshot.owner})` : "";

  return new LockBusy(
    `${path}: lock is held by another process${owner}`,
    "wait for it to finish and run the command again",
  );
};

type Attempt = (path: string) => Promise<string | undefined>;

const acquire = async (path: string, attempt: Attempt, settings: LockSettings): Promise<string> => {
  const mark = await attempt(path);

  if (mark !== undefined) {
    return mark;
  }

  const snapshot = await snapshotOf(path);

  const dead = snapshot !== undefined && !(await stillHeld(snapshot, settings));

  if (dead && (await takeOver(path, snapshot, settings.staleMs))) {
    return acquire(path, attempt, settings);
  }

  if (Date.now() >= settings.deadline) {
    throw busy(path, snapshot);
  }

  await sleep(settings.retryMs);

  return acquire(path, attempt, { ...settings, held: snapshot?.mark });
};

const failure = (path: string, error: unknown) => new LauncherError(`${path}: ${errorMessage(error)}`);

const createPidLock: Attempt = async (path) => {
  const draft = sibling(path, "draft");

  const self = await processMark();

  await writeFile(draft, `${self.pid} ${self.boot} ${self.start} ${randomBytes(8).toString("hex")}`, {
    mode: PRIVATE_MODE,
    flag: "wx",
  });

  try {
    await link(draft, path);

    return (await snapshotOf(draft))?.mark;
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      return undefined;
    }

    throw failure(path, error);
  } finally {
    await rm(draft, { force: true });
  }
};

const createDirectoryLock: Attempt = async (path) => {
  try {
    await mkdir(path);

    return (await snapshotOf(path))?.mark;
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      return undefined;
    }

    throw failure(path, error);
  }
};

const release = async (path: string, mark: string) => {
  if ((await snapshotOf(path))?.mark === mark) {
    await rm(path, { recursive: true, force: true });
  }
};

interface Holding {
  attempt: Attempt;
  byAge: boolean;
  refresh?: number;
}

const holding = async <T>(
  path: string,
  kind: Holding,
  options: FileLockOptions,
  action: () => Promise<T>,
) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const mark = await acquire(path, kind.attempt, settingsOf(options, kind.byAge));
  const refresher =
    kind.refresh === undefined
      ? undefined
      : setInterval(() => {
          const now = new Date();

          void utimes(path, now, now).catch(() => undefined);
        }, kind.refresh);

  refresher?.unref();

  try {
    return await action();
  } finally {
    clearInterval(refresher);

    await release(path, mark);
  }
};

export const withFileLock = <T>(path: string, action: () => Promise<T>, options: FileLockOptions = {}) =>
  holding(path, { attempt: createPidLock, byAge: false }, options, action);

export const withFileLockIfFree = async <T>(
  path: string,
  action: () => Promise<T>,
): Promise<{ busy: true } | { busy: false; value: T }> => {
  const entered = { now: false };

  try {
    const value = await withFileLock(
      path,
      () => {
        entered.now = true;

        return action();
      },
      { timeoutMs: 0 },
    );

    return { busy: false, value };
  } catch (error) {
    if (!entered.now && error instanceof LockBusy) {
      return { busy: true };
    }

    throw error;
  }
};

export const withDirectoryLock = <T>(path: string, action: () => Promise<T>, options: FileLockOptions = {}) =>
  holding(
    path,
    {
      attempt: createDirectoryLock,
      byAge: true,
      refresh: Math.max(
        1,
        Math.min(DIRECTORY_REFRESH_MS, Math.floor((options.staleMs ?? DEFAULT_STALE_MS) / 4)),
      ),
    },
    options,
    action,
  );
