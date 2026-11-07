import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage, LauncherError } from "./errors.ts";

export interface FileLockOptions {
  staleMs?: number;
  timeoutMs?: number;
  retryMs?: number;
}

const DEFAULT_STALE_MS = 10_000;

const DEFAULT_TIMEOUT_MS = 5_000;

const DEFAULT_RETRY_MS = 50;

const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException).code === code;

const ageOf = async (lockPath: string) => {
  const info = await stat(lockPath).catch(() => undefined);

  return info === undefined ? undefined : Date.now() - info.mtimeMs;
};

const tryCreate = async (lockPath: string) => {
  try {
    await mkdir(lockPath);

    return true;
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      return false;
    }

    throw new LauncherError(`${lockPath}: ${errorMessage(error)}`);
  }
};

const acquire = async (
  lockPath: string,
  staleMs: number,
  retryMs: number,
  deadline: number,
): Promise<void> => {
  if (await tryCreate(lockPath)) {
    return;
  }

  const age = await ageOf(lockPath);

  if (age !== undefined && age > staleMs) {
    await rm(lockPath, { recursive: true, force: true });

    return acquire(lockPath, staleMs, retryMs, deadline);
  }

  if (Date.now() >= deadline) {
    throw new LauncherError(`${lockPath}: lock is held by another process`, "try again in a moment");
  }

  await sleep(retryMs);

  return acquire(lockPath, staleMs, retryMs, deadline);
};

const keepFresh = (lockPath: string, staleMs: number) =>
  setInterval(
    () => {
      const now = new Date();

      void utimes(lockPath, now, now).catch(() => undefined);
    },
    Math.max(1, Math.floor(staleMs / 2)),
  );

export const withFileLock = async <T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> => {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  await acquire(
    lockPath,
    staleMs,
    options.retryMs ?? DEFAULT_RETRY_MS,
    Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );

  const refresher = keepFresh(lockPath, staleMs);

  try {
    return await fn();
  } finally {
    clearInterval(refresher);

    await rm(lockPath, { recursive: true, force: true });
  }
};
