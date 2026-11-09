import { stat, utimes } from "node:fs/promises";
import { uptime } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

export interface ProcessMark {
  pid: number;
  boot: number;
}

export const HEARTBEAT_MS = 30_000;

const FRESH_MS = 90_000;

const BOOT_SKEW_SECONDS = 30;

const EXIT_POLL_MS = 50;

export const bootTime = () => Math.round(Date.now() / 1000 - uptime());

export const processMark = (): ProcessMark => ({ pid: process.pid, boot: bootTime() });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isMark = (mark: Partial<ProcessMark>): mark is ProcessMark =>
  Number.isInteger(mark.pid) && (mark.pid ?? 0) > 0 && Number.isFinite(mark.boot);

export const isLive = (mark: Partial<ProcessMark>, mtimeMs: number, now = Date.now()) =>
  isMark(mark) &&
  Math.abs(mark.boot - bootTime()) <= BOOT_SKEW_SECONDS &&
  now - mtimeMs < FRESH_MS &&
  isAlive(mark.pid);

export const isLiveFile = async (path: string, mark: Partial<ProcessMark>) => {
  const info = await stat(path).catch(() => undefined);

  return info !== undefined && isLive(mark, info.mtimeMs);
};

export const heartbeat = (path: string, intervalMs = HEARTBEAT_MS) => {
  const timer = setInterval(() => {
    const now = new Date();

    void utimes(path, now, now).catch(() => undefined);
  }, intervalMs);

  timer.unref();

  return () => clearInterval(timer);
};

const exited = async (pid: number, deadline: number): Promise<boolean> => {
  if (!isAlive(pid)) {
    return true;
  }

  if (Date.now() >= deadline) {
    return false;
  }

  await sleep(EXIT_POLL_MS);

  return exited(pid, deadline);
};

const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
  } catch {
    return;
  }
};

export const terminateProcess = async (pid: number, graceMs: number) => {
  signal(pid, "SIGTERM");

  if (!(await exited(pid, Date.now() + graceMs))) {
    signal(pid, "SIGKILL");
  }
};
