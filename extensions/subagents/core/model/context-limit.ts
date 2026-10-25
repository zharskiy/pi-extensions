import type { HandoffBudget } from "../../../../platform/shared/index.ts";
import type { Settings } from "./settings.ts";

const UNKNOWN_LIMIT = 0;

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
): HandoffBudget => {
  const request = effectiveContextLimit(definitionLimit, window, settings.reserveTokens);

  return {
    request,
    warn: request * settings.softContextRatio,
    ceiling: request * settings.hardContextRatio,
    graceTurns: 2,
    maxTurnsAfterRequest: 3,
  };
};
