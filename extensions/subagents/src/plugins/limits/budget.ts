import type { ContextSnapshot } from "../../../../../core/adapter/contract.ts";

export const effectiveBudget = (budgetTokens: number, context: ContextSnapshot, reserveTokens: number) => {
  if (context.window <= 0) {
    return budgetTokens;
  }

  return Math.max(1, Math.min(budgetTokens, context.window - reserveTokens));
};

export type BudgetStep = "none" | "warn" | "handoff" | "abort";

export type BudgetInput = {
  tokens: number;
  budget: number;
  softRatio: number;
  hardRatio: number;
  warned: boolean;
  handoffRequested: boolean;
  turnsSinceHandoff: number;
  maxTurnsAfterHandoff: number;
};

export const budgetStep = (input: BudgetInput): BudgetStep => {
  if (input.handoffRequested) {
    const overHard = input.tokens >= input.budget * input.hardRatio;
    const tooManyTurns = input.turnsSinceHandoff >= input.maxTurnsAfterHandoff;

    return overHard || tooManyTurns ? "abort" : "none";
  }

  if (input.tokens >= input.budget) {
    return "handoff";
  }

  if (!input.warned && input.tokens >= input.budget * input.softRatio) {
    return "warn";
  }

  return "none";
};

export const softWarning = (tokens: number, budget: number) =>
  `Context budget warning: about ${Math.round((tokens / budget) * 100)}% of your ${budget}-token budget is used. Finish the current step, avoid reading large files, and prepare to wrap up.`;

export const turnLimitWarning = (maxTurns: number) =>
  `Turn limit reached (${maxTurns} turns). Stop exploring and reply now with your final result.`;
