export type HandoffBudget = { request: number; warn: number };

export type StepBudget = HandoffBudget & {
  ceiling: number;
  graceTurns: number;
  maxTurnsAfterRequest: number;
};

export type BudgetState = { warned: boolean; requested: boolean; turnsSinceRequest: number };

type BudgetStep = "none" | "warn" | "request" | "abort";

export type BudgetLevel = "unknown" | "normal" | "soft" | "hard";

export const budgetLevel = (tokens: number | null, budget: HandoffBudget | undefined): BudgetLevel => {
  if (tokens === null || !budget) {
    return "unknown";
  }

  if (tokens >= budget.request) {
    return "hard";
  }

  return tokens >= budget.warn ? "soft" : "normal";
};

const shouldAbort = (tokens: number, budget: StepBudget, turnsSinceRequest: number) => {
  const ceilingAbort = tokens >= budget.ceiling && turnsSinceRequest >= budget.graceTurns;

  return ceilingAbort || turnsSinceRequest >= budget.maxTurnsAfterRequest;
};

export const budgetStep = (tokens: number, budget: StepBudget, state: BudgetState): BudgetStep => {
  if (state.requested) {
    return shouldAbort(tokens, budget, state.turnsSinceRequest) ? "abort" : "none";
  }

  if (tokens >= budget.request) {
    return "request";
  }

  return !state.warned && tokens >= budget.warn ? "warn" : "none";
};
