import { describe, expect, it } from "vitest";
import { type BudgetState, budgetLevel, budgetStep, type StepBudget } from "../handoff-budget.ts";

const agent: StepBudget = {
  request: 100_000,
  warn: 80_000,
  ceiling: 115_000,
  graceTurns: 2,
  maxTurnsAfterRequest: 3,
};

const fresh: BudgetState = { warned: false, requested: false, turnsSinceRequest: 0 };

const requestedFor = (turnsSinceRequest: number): BudgetState => ({
  warned: true,
  requested: true,
  turnsSinceRequest,
});

describe("budget step before the request", () => {
  it("requests at the request line, warns once at the warn line and is quiet below it", () => {
    expect(budgetStep(79_999, agent, fresh)).toBe("none");
    expect(budgetStep(80_000, agent, fresh)).toBe("warn");
    expect(budgetStep(85_000, agent, { ...fresh, warned: true })).toBe("none");
    expect(budgetStep(100_000, agent, { ...fresh, warned: true })).toBe("request");
    expect(budgetStep(100_000, agent, fresh)).toBe("request");
  });
});

describe("budget step after the request", () => {
  it("waits out the grace turns before the ceiling aborts", () => {
    expect(budgetStep(150_000, agent, requestedFor(0))).toBe("none");
    expect(budgetStep(150_000, agent, requestedFor(1))).toBe("none");
    expect(budgetStep(115_000, agent, requestedFor(2))).toBe("abort");
  });

  it("aborts after the turn cap even under the ceiling", () => {
    expect(budgetStep(101_000, agent, requestedFor(2))).toBe("none");
    expect(budgetStep(101_000, agent, requestedFor(3))).toBe("abort");
  });
});

describe("budget level", () => {
  it("is unknown without tokens or a budget", () => {
    expect(budgetLevel(null, agent)).toBe("unknown");
    expect(budgetLevel(10, undefined)).toBe("unknown");
  });

  it("goes normal, soft and hard as tokens grow", () => {
    expect(budgetLevel(79_999, agent)).toBe("normal");
    expect(budgetLevel(80_000, agent)).toBe("soft");
    expect(budgetLevel(100_000, agent)).toBe("hard");
  });
});
