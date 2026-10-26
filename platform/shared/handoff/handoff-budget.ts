export type Limits = { softRatio: number; hardRatio: number; softTokens: number; hardTokens: number };

export type HandoffBudget = { request: number; warn: number };

export const mainBudget = (window: number, limits: Limits): HandoffBudget | undefined => {
  if (window <= 0) {
    return undefined;
  }

  return {
    request: Math.min(window * limits.hardRatio, limits.hardTokens),
    warn: Math.min(window * limits.softRatio, limits.softTokens),
  };
};

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
