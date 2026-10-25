import { describe, expect, it } from "vitest";
import { agentBudget, effectiveContextLimit } from "../../core/model/context-limit.ts";

describe("effective context limit", () => {
  it("uses the declared limit unless the model window minus the reserve is smaller", () => {
    expect(effectiveContextLimit(100_000, 400_000, 16_384)).toBe(100_000);
    expect(effectiveContextLimit(100_000, 64_000, 16_384)).toBe(47_616);
    expect(effectiveContextLimit(300_000, 200_000, 16_000)).toBe(184_000);
  });

  it("keeps the declared limit when the model window is unknown", () => {
    expect(effectiveContextLimit(100_000, 0, 16_000)).toBe(100_000);
  });
});

describe("agent budget", () => {
  const settings = { reserveTokens: 16_000, softContextRatio: 0.8, hardContextRatio: 1.15 };

  it("requests at the effective limit, warns at the soft ratio and aborts past the hard ratio", () => {
    const budget = agentBudget(100_000, 400_000, settings);

    expect(budget).toMatchObject({ request: 100_000, warn: 80_000 });
    expect(budget.ceiling).toBeCloseTo(115_000);
  });

  it("caps the request by the window minus the reserve", () => {
    expect(agentBudget(300_000, 200_000, settings).request).toBe(184_000);
  });
});
