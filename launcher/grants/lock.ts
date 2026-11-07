import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LauncherError } from "../shared/index.ts";

const POLL_MS = 25;

const LOCK_TIMEOUT_MS = 10_000;

const PRIVATE_MODE = 0o600;

const UNREADABLE_STALE_MS = 10_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException).code === code;

const tryCreate = async (path: string) => {
  const draft = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;

  await writeFile(draft, String(process.pid), { mode: PRIVATE_MODE, flag: "wx" });

  try {
    await link(draft, path);

    return true;
  } catch (error) {
    if (!isCode(error, "EEXIST")) {
      throw new LauncherError(`cannot lock ${path}: ${(error as Error).message}`);
    }

    return false;
  } finally {
    await rm(draft, { force: true });
  }
};

const ownerOf = async (path: string) => Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);

const isFresh = async (path: string) => {
  const info = await stat(path).catch(() => undefined);

  return info !== undefined && Date.now() - info.mtimeMs < UNREADABLE_STALE_MS;
};

const isLiveOwner = async (path: string) => {
  const owner = await ownerOf(path);

  return Number.isInteger(owner) ? isProcessAlive(owner) : isFresh(path);
};

const removeIfStale = async (path: string) => {
  if (await isLiveOwner(path)) {
    return;
  }

  const moved = `${path}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
  const renamed = await rename(path, moved).then(
    () => true,
    () => false,
  );

  if (!renamed) {
    return;
  }

  if (await isLiveOwner(moved)) {
    await link(moved, path).catch(() => undefined);
  }

  await rm(moved, { force: true });
};

const acquire = async (path: string, deadline: number): Promise<void> => {
  if (await tryCreate(path)) {
    return;
  }

  await removeIfStale(path);

  if (Date.now() >= deadline) {
    throw new LauncherError(`${path} is held by another launcher`, "wait for it, or remove the file");
  }

  await delay(POLL_MS);

  return acquire(path, deadline);
};

export const withFileLock = async <T>(path: string, action: () => Promise<T>) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  await acquire(path, Date.now() + LOCK_TIMEOUT_MS);

  try {
    return await action();
  } finally {
    await rm(path, { force: true });
  }
};
