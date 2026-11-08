import { randomBytes } from "node:crypto";
import { link, mkdir, open, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage, LauncherError } from "./errors.ts";

export interface FileLockOptions {
  staleMs?: number;
  timeoutMs?: number;
  retryMs?: number;
}

interface LockSettings {
  staleMs?: number;
  retryMs: number;
  deadline: number;
}

interface LockSnapshot {
  owner: number;
  mark: string;
  mtimeMs: number;
}

const DEFAULT_STALE_MS = 10_000;

const DEFAULT_TIMEOUT_MS = 10_000;

const DEFAULT_RETRY_MS = 25;

const DIRECTORY_REFRESH_MS = 1_000;

const PRIVATE_MODE = 0o600;

const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException).code === code;

export const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
};

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

  await handle?.close();

  return { owner: Number.parseInt(text, 10), mark, mtimeMs: info.mtimeMs };
};

const isHeld = (snapshot: LockSnapshot, staleMs: number | undefined) =>
  staleMs === undefined
    ? Number.isInteger(snapshot.owner) && snapshot.owner > 0 && isProcessAlive(snapshot.owner)
    : Date.now() - snapshot.mtimeMs <= staleMs;

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

  if (found !== undefined && !sameLock(found, stale) && isHeld(found, staleMs)) {
    await restore(moved, path);
  }

  await rm(moved, { recursive: true, force: true });
};

const clearDeadGuard = async (guard: string) => {
  const snapshot = await snapshotOf(guard);

  if (snapshot !== undefined && !isHeld(snapshot, undefined)) {
    await moveAside(guard, snapshot, undefined);
  }
};

const takeOver = async (path: string, stale: LockSnapshot, staleMs: number | undefined) => {
  const guard = `${path}.takeover`;
  const mark = await createPidLock(guard);

  if (mark === undefined) {
    await clearDeadGuard(guard);

    return;
  }

  try {
    const current = await snapshotOf(path);

    if (current !== undefined && sameLock(current, stale) && !isHeld(current, staleMs)) {
      await moveAside(path, stale, staleMs);
    }
  } finally {
    await release(guard, mark);
  }
};

class LockBusy extends LauncherError {}

const busy = (path: string, snapshot: LockSnapshot | undefined) => {
  const owner = snapshot !== undefined && Number.isInteger(snapshot.owner) ? ` (pid ${snapshot.owner})` : "";

  return new LockBusy(
    `${path}: lock is held by another process${owner}`,
    `wait for it, or remove ${path} if that process is gone`,
  );
};

type Attempt = (path: string) => Promise<string | undefined>;

const acquire = async (path: string, attempt: Attempt, settings: LockSettings): Promise<string> => {
  const mark = await attempt(path);

  if (mark !== undefined) {
    return mark;
  }

  const snapshot = await snapshotOf(path);

  if (snapshot !== undefined && !isHeld(snapshot, settings.staleMs)) {
    await takeOver(path, snapshot, settings.staleMs);

    return acquire(path, attempt, settings);
  }

  if (Date.now() >= settings.deadline) {
    throw busy(path, snapshot);
  }

  await sleep(settings.retryMs);

  return acquire(path, attempt, settings);
};

const failure = (path: string, error: unknown) => new LauncherError(`${path}: ${errorMessage(error)}`);

const createPidLock: Attempt = async (path) => {
  const draft = sibling(path, "draft");

  await writeFile(draft, `${process.pid}:${randomBytes(8).toString("hex")}`, {
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

const holding = async <T>(
  path: string,
  attempt: Attempt,
  options: FileLockOptions,
  action: () => Promise<T>,
  refresh?: number,
) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const mark = await acquire(path, attempt, settingsOf(options, refresh !== undefined));
  const refresher =
    refresh === undefined
      ? undefined
      : setInterval(() => {
          const now = new Date();

          void utimes(path, now, now).catch(() => undefined);
        }, refresh);

  try {
    return await action();
  } finally {
    clearInterval(refresher);

    await release(path, mark);
  }
};

export const withFileLock = <T>(path: string, action: () => Promise<T>, options: FileLockOptions = {}) =>
  holding(path, createPidLock, options, action);

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
    createDirectoryLock,
    options,
    action,
    Math.max(1, Math.min(DIRECTORY_REFRESH_MS, Math.floor((options.staleMs ?? DEFAULT_STALE_MS) / 4))),
  );
