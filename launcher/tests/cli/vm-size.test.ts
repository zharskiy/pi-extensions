import { describe, expect, it } from "vitest";
import { recommendedVmSize } from "../../cli/vm.ts";

const SAMPLES: Array<[number, number, { cpus: number; memoryGiB: number }]> = [
  [1, 2, { cpus: 2, memoryGiB: 4 }],
  [2, 7, { cpus: 2, memoryGiB: 4 }],
  [4, 8, { cpus: 4, memoryGiB: 4 }],
  [8, 16, { cpus: 8, memoryGiB: 8 }],
  [10, 18, { cpus: 8, memoryGiB: 9 }],
  [12, 24, { cpus: 8, memoryGiB: 10 }],
  [16, 64, { cpus: 8, memoryGiB: 10 }],
];

describe("the automatic VM size", () => {
  it("recommends this Mac's CPUs from 2 to 8, half its memory from 4 to 10 GiB, and a 60 GiB disk", () => {
    SAMPLES.forEach(([cpus, memGiB, size]) => {
      expect(recommendedVmSize(cpus, memGiB)).toEqual({ ...size, diskGiB: 60 });
    });
  });
});
