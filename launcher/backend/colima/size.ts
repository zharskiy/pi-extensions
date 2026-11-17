import { GIB, LauncherError, parseJsonObject, type RunResult } from "../../shared/index.ts";
import type { VmReport, VmSize, VmSpec, VmTarget } from "../types.ts";
import { vmSizeDrift } from "../vm-size.ts";
import { vmSizeOfYaml } from "./colima-yaml.ts";

const STATUS_TIMEOUT_MS = 3000;

export type StatusRun = (args: string[], extra: { timeoutMs: number }) => Promise<RunResult>;

export const sizeFlags = (target: VmTarget) => [
  ...(target.cpus === undefined ? [] : ["--cpu", String(target.cpus)]),
  ...(target.memoryGiB === undefined ? [] : ["--memory", String(target.memoryGiB)]),
  ...(target.diskGiB === undefined ? [] : ["--disk", String(target.diskGiB)]),
];

export const shrinkNotice = (target: VmTarget, keptDiskGiB: number) =>
  `vm.diskGiB ${target.diskGiB} is below the sandbox VM's disk of ${keptDiskGiB} GiB; colima cannot shrink a disk, so it stays`;

export const coldStartSize = (profileYaml: string | undefined, target: VmTarget, report: VmReport) => {
  const current = profileYaml === undefined ? undefined : vmSizeOfYaml(profileYaml);

  if (current === undefined) {
    return { cpus: target.cpus, memoryGiB: target.memoryGiB };
  }

  const drift = vmSizeDrift(current, target);

  if (drift.keptDiskGiB !== undefined) {
    report(shrinkNotice(target, drift.keptDiskGiB));
  }

  return drift.changes;
};

export const statusSize = async (run: StatusRun, profile: string): Promise<VmSize | undefined> => {
  const result = await run(["status", "--profile", profile, "--json"], { timeoutMs: STATUS_TIMEOUT_MS });

  if (result.timedOut === true) {
    throw new LauncherError(`colima did not answer within ${STATUS_TIMEOUT_MS / 1000} seconds`);
  }

  const vm = result.code === 0 ? parseJsonObject(result.stdout) : undefined;

  if (typeof vm?.cpu !== "number" || typeof vm.memory !== "number") {
    return undefined;
  }

  const measured = { cpus: vm.cpu, memoryGiB: vm.memory / GIB };

  return typeof vm.disk === "number" ? { ...measured, diskGiB: vm.disk / GIB } : measured;
};

export const completeSize = (
  profile: string,
  measured: VmSize | undefined,
  configured: VmSize | undefined,
): VmSpec => {
  const diskGiB = measured?.diskGiB ?? configured?.diskGiB;
  const known = measured ?? configured;

  if (known === undefined || diskGiB === undefined) {
    throw new LauncherError(`colima reported no size for profile ${profile}`);
  }

  return { cpus: known.cpus, memoryGiB: Math.round(known.memoryGiB), diskGiB: Math.round(diskGiB) };
};
