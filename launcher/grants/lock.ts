import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LauncherError } from "../shared/index.ts";

const POLL_MS = 25;

const LOCK_TIMEOUT_MS = 10_000;

const PRIVATE_MODE = 0o600;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const tryCreate = (path: string) =>
  writeFile(path, String(process.pid), { mode: PRIVATE_MODE, flag: "wx" }).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") {
        throw new LauncherError(`cannot lock ${path}: ${error.message}`);
      }

      return false;
    },
  );

const ownerOf = async (path: string) => Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);

const isLiveOwner = (owner: number) => Number.isInteger(owner) && isProcessAlive(owner);

const removeIfStale = async (path: string) => {
  if (isLiveOwner(await ownerOf(path))) {
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

  if (isLiveOwner(await ownerOf(moved))) {
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
