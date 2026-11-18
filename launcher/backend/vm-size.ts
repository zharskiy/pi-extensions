import type { VmSize, VmTarget } from "./types.ts";

interface SizeDrift {
  changes: VmTarget;
  keptDiskGiB?: number;
}

const differs = (wanted: number | undefined, current: number) =>
  wanted !== undefined && wanted !== Math.round(current) ? wanted : undefined;

const definedOnly = (target: VmTarget): VmTarget =>
  Object.fromEntries(Object.entries(target).filter(([, value]) => value !== undefined));

export const vmSizeDrift = (current: VmSize, target: VmTarget): SizeDrift => {
  const disk = current.diskGiB === undefined ? undefined : Math.round(current.diskGiB);
  const grown = target.diskGiB !== undefined && disk !== undefined && target.diskGiB > disk;
  const shrunk = target.diskGiB !== undefined && disk !== undefined && target.diskGiB < disk;
  const changes = definedOnly({
    cpus: differs(target.cpus, current.cpus),
    memoryGiB: differs(target.memoryGiB, current.memoryGiB),
    diskGiB: grown ? target.diskGiB : undefined,
  });

  return shrunk ? { changes, keptDiskGiB: disk } : { changes };
};

export const hasSizeChanges = (drift: SizeDrift) => Object.keys(drift.changes).length > 0;

export const vmSizeText = (size: VmTarget) =>
  [
    ...(size.cpus === undefined ? [] : [`${size.cpus} CPUs`]),
    ...(size.memoryGiB === undefined ? [] : [`${size.memoryGiB} GiB memory`]),
    ...(size.diskGiB === undefined ? [] : [`${size.diskGiB} GiB disk`]),
  ].join(", ");
