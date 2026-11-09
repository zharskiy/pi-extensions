import { uptime } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { processStart } from "./process-start.ts";

export interface ProcessMark {
  pid: number;
  boot: number;
  start: string;
}

const BOOT_SKEW_SECONDS = 30;

const EXIT_POLL_MS = 50;

export const bootTime = () => Math.round(Date.now() / 1000 - uptime());

const ownStart = { value: undefined as Promise<string> | undefined };

const startOfSelf = () => {
  ownStart.value ??= processStart(process.pid).then((start) => start ?? "");

  return ownStart.value;
};

export const processMark = async (): Promise<ProcessMark> => ({
  pid: process.pid,
  boot: bootTime(),
  start: await startOfSelf(),
});

export const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isMark = (mark: Partial<ProcessMark>): mark is ProcessMark =>
  Number.isInteger(mark.pid) &&
  (mark.pid ?? 0) > 0 &&
  Number.isFinite(mark.boot) &&
  typeof mark.start === "string" &&
  mark.start !== "";

export const isLive = async (mark: Partial<ProcessMark>) =>
  isMark(mark) &&
  Math.abs(mark.boot - bootTime()) <= BOOT_SKEW_SECONDS &&
  isRunning(mark.pid) &&
  (await processStart(mark.pid)) === mark.start;

const exited = async (pid: number, deadline: number): Promise<boolean> => {
  if (!isRunning(pid)) {
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
