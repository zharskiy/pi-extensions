import type { HandoffBudget } from "../../../../platform/shared/index.ts";
import type { Settings } from "./settings.ts";

const UNKNOWN_LIMIT = 0;

export type StepBudget = HandoffBudget & {
  ceiling: number;
  graceTurns: number;
  maxTurnsAfterRequest: number;
};

type BudgetState = { warned: boolean; requested: boolean; turnsSinceRequest: number };

type BudgetStep = "none" | "warn" | "request" | "abort";

export const effectiveContextLimit = (limit: number, window: number, reserveTokens: number) => {
  if (window <= 0 || limit <= UNKNOWN_LIMIT) {
    return limit;
  }

  return Math.max(1, Math.min(limit, window - reserveTokens));
};

export const agentBudget = (
  definitionLimit: number,
  window: number,
  settings: Pick<Settings, "reserveTokens" | "softContextRatio" | "hardContextRatio">,
): StepBudget => {
  const request = effectiveContextLimit(definitionLimit, window, settings.reserveTokens);

  return {
    request,
    warn: request * settings.softContextRatio,
    ceiling: request * settings.hardContextRatio,
    graceTurns: 2,
    maxTurnsAfterRequest: 3,
  };
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
