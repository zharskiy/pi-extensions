import { describe, expect, it } from "vitest";
import { vmSharesOf } from "../../backend/colima/colima-yaml.ts";
import type { VmShare } from "../../backend/index.ts";
import { type VmDecision, type VmFound, vmDecision, whenBusy } from "../../backend/vm-decision.ts";

const SIZE = { cpus: 4, memoryGiB: 8, diskGiB: 60 };

const WORK = { location: "/work", writable: true };

const DATA = { location: "/data", writable: false };

const running = (shares: VmShare[] | "unreadable" = [WORK]): VmFound => ({
  state: "running",
  size: SIZE,
  shares,
});

describe("vmDecision", () => {
  it("creates an absent VM", () => {
    expect(vmDecision({ state: "absent" }, { size: SIZE, shares: [WORK] })).toEqual({
      kind: "create",
    });
  });

  it("changes nothing when the size and the shares match", () => {
    expect(vmDecision(running(), { size: SIZE, shares: [WORK] })).toEqual({
      kind: "none",
      resize: {},
      reshare: false,
    });
  });

  it("changes nothing when lima writes the planned shares back with a trailing slash", () => {
    const yaml =
      "mounts:\n  - location: /work/\n    writable: true\n  - location: /data/\n    writable: false\n";
    const shares = vmSharesOf(yaml, "/home/dev") ?? "unreadable";

    expect(vmDecision(running(shares), { size: SIZE, shares: [WORK, DATA] })).toEqual({
      kind: "none",
      resize: {},
      reshare: false,
    });
  });

  it("leaves a stopped VM that drifts to its next start", () => {
    const found: VmFound = { state: "stopped", size: SIZE, shares: [WORK] };

    expect(vmDecision(found, { size: { cpus: 6 } })).toEqual({
      kind: "stopped",
      resize: { cpus: 6 },
      reshare: false,
    });
  });

  it("restarts for a size change, a lacking share or shares it cannot read", () => {
    expect(vmDecision(running(), { size: { memoryGiB: 12 } })).toMatchObject({
      kind: "restart",
      resize: { memoryGiB: 12 },
      reshare: false,
    });
    expect(vmDecision(running(), { size: {}, shares: [WORK, DATA] })).toMatchObject({
      kind: "restart",
      reshare: true,
    });
    expect(vmDecision(running("unreadable"), { size: {}, shares: [WORK] })).toMatchObject({
      kind: "restart",
      reshare: true,
    });
  });

  it("restarts for an extra share", () => {
    expect(vmDecision(running([WORK, DATA]), { size: {}, shares: [WORK] })).toMatchObject({
      kind: "restart",
      reshare: true,
    });
  });

  it("keeps a larger disk without counting it as a change", () => {
    expect(vmDecision(running(), { size: { diskGiB: 40 } })).toEqual({
      kind: "none",
      resize: {},
      reshare: false,
      keptDiskGiB: 60,
    });
  });

  it("reads no size drift when the size is unknown", () => {
    const found: VmFound = { state: "running", shares: [WORK] };

    expect(vmDecision(found, { size: { cpus: 8 } }).kind).toBe("none");
  });
});

describe("whenBusy", () => {
  const restart: VmDecision = { kind: "restart", resize: { cpus: 8 }, reshare: false };

  it("defers a restart while sessions run and keeps the change", () => {
    expect(whenBusy(restart, 2)).toEqual({ kind: "defer", sessions: 2, resize: { cpus: 8 }, reshare: false });
  });

  it("keeps a restart when no session runs", () => {
    expect(whenBusy(restart, 0)).toBe(restart);
  });

  it("leaves every other decision alone", () => {
    const others: VmDecision[] = [
      { kind: "create" },
      { kind: "none", resize: {}, reshare: false },
      { kind: "stopped", resize: { cpus: 8 }, reshare: false },
    ];

    expect(others.map((decision) => whenBusy(decision, 3))).toEqual(others);
  });
});
