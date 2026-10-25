export type HandoffBudget = {
  request: number;
  warn?: number;
  ceiling?: number;
  graceTurns?: number;
  maxTurnsAfterRequest?: number;
};

export type BudgetState = { warned: boolean; requested: boolean; turnsSinceRequest: number };

export type BudgetStep = "none" | "warn" | "request" | "abort";

export type BudgetLevel = "unknown" | "normal" | "soft" | "hard";

export const budgetLevel = (tokens: number | null, budget: HandoffBudget | undefined): BudgetLevel => {
  if (tokens === null || !budget) {
    return "unknown";
  }

  if (tokens >= budget.request) {
    return "hard";
  }

  return budget.warn !== undefined && tokens >= budget.warn ? "soft" : "normal";
};

const shouldAbort = (tokens: number, budget: HandoffBudget, turnsSinceRequest: number) => {
  const overCeiling = budget.ceiling !== undefined && tokens >= budget.ceiling;
  const graceUsed = turnsSinceRequest >= (budget.graceTurns ?? 0);
  const tooManyTurns =
    budget.maxTurnsAfterRequest !== undefined && turnsSinceRequest >= budget.maxTurnsAfterRequest;

  return (overCeiling && graceUsed) || tooManyTurns;
};

export const budgetStep = (tokens: number, budget: HandoffBudget, state: BudgetState): BudgetStep => {
  if (state.requested) {
    return shouldAbort(tokens, budget, state.turnsSinceRequest) ? "abort" : "none";
  }

  if (tokens >= budget.request) {
    return "request";
  }

  return !state.warned && budget.warn !== undefined && tokens >= budget.warn ? "warn" : "none";
};
