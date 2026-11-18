import type { VmShare, VmSize, VmTarget } from "./types.ts";
import { hasSizeChanges, vmSizeDrift } from "./vm-size.ts";

export type VmFound =
  | { state: "absent" }
  | { state: "stopped" | "running"; size?: VmSize; shares: VmShare[] | "unreadable" };

export interface VmWanted {
  size: VmTarget;
  shares?: VmShare[];
  exactShares: boolean;
}

export interface VmChange {
  resize: VmTarget;
  reshare: boolean;
  keptDiskGiB?: number;
}

export type VmDecision =
  | { kind: "create" }
  | ({ kind: "none" | "stopped" | "restart" } & VmChange)
  | ({ kind: "defer"; sessions: number } & VmChange);

const sameShare = (share: VmShare) => (other: VmShare) =>
  other.location === share.location && other.writable === share.writable;

export const shareDrift = (current: VmShare[], desired: VmShare[]) => ({
  extra: current.filter((share) => !desired.some(sameShare(share))),
  lacking: desired.filter((share) => !current.some(sameShare(share))),
});

const sharesDiffer = (current: VmShare[] | "unreadable", wanted: VmWanted) => {
  if (wanted.shares === undefined) {
    return false;
  }

  if (current === "unreadable") {
    return true;
  }

  const drift = shareDrift(current, wanted.shares);

  return drift.lacking.length > 0 || (wanted.exactShares && drift.extra.length > 0);
};

export const vmDecision = (found: VmFound, wanted: VmWanted): VmDecision => {
  if (found.state === "absent") {
    return { kind: "create" };
  }

  const drift = found.size === undefined ? { changes: {} } : vmSizeDrift(found.size, wanted.size);
  const change: VmChange = {
    resize: drift.changes,
    reshare: sharesDiffer(found.shares, wanted),
    ...("keptDiskGiB" in drift ? { keptDiskGiB: drift.keptDiskGiB } : {}),
  };

  if (!hasSizeChanges(drift) && !change.reshare) {
    return { kind: "none", ...change };
  }

  return { kind: found.state === "stopped" ? "stopped" : "restart", ...change };
};

export const whenBusy = (decision: VmDecision, sessions: number): VmDecision =>
  decision.kind === "restart" && sessions > 0 ? { ...decision, kind: "defer", sessions } : decision;
