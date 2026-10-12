import { describe, expect, it } from "vitest";
import { contextOf, sumUsage } from "../../adapter/usage.ts";

const usage = (total: number) => ({ input: 1, output: 1, totalTokens: 2, cost: { total } });

describe("usage", () => {
  it("sums assistant, tool result, usage, compaction and branch summary entries", () => {
    const totals = sumUsage([
      { type: "message", message: { role: "assistant", usage: usage(1) } },
      { type: "message", message: { role: "toolResult", usage: usage(2) } },
      { type: "message", message: { role: "user", usage: usage(100) } },
      { type: "usage", usage: usage(4) },
      { type: "compaction", usage: usage(8) },
      { type: "branch_summary", usage: usage(16) },
      { type: "custom" },
    ]);

    expect(totals.cost.total).toBe(31);
    expect(totals.totalTokens).toBe(10);
  });

  it("falls back to the model's window when pi has no context usage yet", () => {
    expect(contextOf({ getContextUsage: () => undefined, model: { contextWindow: 1_000 } })).toEqual({
      tokens: null,
      window: 1_000,
      percent: null,
    });
  });
});
