import { describe, expect, it, vi } from "vitest";
import { pause } from "../../../test/framework/index.ts";
import { pooled } from "../core/pool.ts";

const later = <T>(value: T, ms: number) => pause(ms).then(() => value);

async function* counted(count: number) {
  yield* Array.from({ length: count }, (_, index) => index);
}

describe("pooled", () => {
  it("keeps source order with out-of-order completion", async () => {
    expect(await pooled([3, 1, 2, 0], (ms) => later(ms, ms), 4)).toEqual([3, 1, 2, 0]);
  });

  it("never runs more than the limit at once", async () => {
    const counts = { running: 0, most: 0 };

    await pooled(
      Array.from({ length: 20 }, (_, index) => index),
      async (index) => {
        counts.running += 1;
        counts.most = Math.max(counts.most, counts.running);
        await pause(index % 4);
        counts.running -= 1;
      },
      3,
    );

    expect(counts.most).toBe(3);
  });

  it("drains an async iterable", async () => {
    expect(await pooled(counted(5), async (index) => index * 2, 2)).toEqual([0, 2, 4, 6, 8]);
  });

  it("stops pulling after a step rejects and rethrows once every running step settled", async () => {
    const pulled: number[] = [];
    const settled: number[] = [];

    const step = async (index: number) => {
      pulled.push(index);

      if (index === 1) {
        throw new Error("step failed");
      }

      await pause(20);
      settled.push(index);
    };

    await expect(pooled([0, 1, 2, 3, 4, 5], step, 2)).rejects.toThrow("step failed");
    expect(pulled).toEqual([0, 1]);
    expect(settled).toEqual([0]);
  });

  it("closes the iterator when a step rejects", async () => {
    const source = counted(10);
    const closed = vi.spyOn(source, "return");

    await expect(
      pooled(
        source,
        async (index) => {
          if (index === 2) {
            throw new Error("step failed");
          }
        },
        2,
      ),
    ).rejects.toThrow("step failed");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array for an empty source", async () => {
    expect(await pooled([], async () => 1, 4)).toEqual([]);
  });

  it("handles more items than workers times a thousand without a stack overflow", async () => {
    const results = await pooled(
      Array.from({ length: 100_000 }, (_, index) => index),
      async (index) => index,
      4,
    );

    expect(results).toHaveLength(100_000);
    expect(results.at(-1)).toBe(99_999);
  });
});
