import { describe, expect, it } from "vitest";
import { budgetLevel, mainBudget, thresholdsFor } from "../handoff/handoff-budget.ts";

const budget = { request: 100_000, warn: 80_000 };

describe("budget level", () => {
  it("is unknown without tokens or a budget", () => {
    expect(budgetLevel(null, budget)).toBe("unknown");
    expect(budgetLevel(10, undefined)).toBe("unknown");
  });

  it("goes normal, soft and hard as tokens grow", () => {
    expect(budgetLevel(79_999, budget)).toBe("normal");
    expect(budgetLevel(80_000, budget)).toBe("soft");
    expect(budgetLevel(100_000, budget)).toBe("hard");
  });
});

const limits = { softRatio: 0.45, hardRatio: 0.6, softTokens: 125_000, hardTokens: 175_000 };

describe("thresholdsFor", () => {
  it("caps the thresholds by tokens on a large window", () => {
    expect(thresholdsFor(1_000_000, limits)).toEqual({ soft: 125_000, hard: 175_000 });
  });

  it("keeps the ratios when they are below the caps", () => {
    expect(thresholdsFor(200_000, limits)).toEqual({ soft: 90_000, hard: 120_000 });
  });
});

describe("mainBudget", () => {
  it("requests at the hard threshold and warns at the soft one", () => {
    expect(mainBudget(200_000, limits)).toEqual({ request: 120_000, warn: 90_000 });
  });

  it("is undefined for an unknown window", () => {
    expect(mainBudget(0, limits)).toBeUndefined();
  });
});
