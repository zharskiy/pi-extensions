import { describe, expect, it } from "vitest";
import { contextTokensOf, estimateTextTokens } from "../../adapter/pi-tokens.ts";

const usage = (totalTokens: number) => ({
  input: 100,
  output: 20,
  cacheRead: 50,
  cacheWrite: 10,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("pi token helpers", () => {
  it("estimates text with pi's characters / 4 heuristic", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcde")).toBe(2);
  });

  it("measures the context of a response from its total, or the sum of its parts", () => {
    expect(contextTokensOf(usage(500))).toBe(500);
    expect(contextTokensOf(usage(0))).toBe(180);
  });
});
