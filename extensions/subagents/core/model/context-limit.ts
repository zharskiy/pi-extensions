import type { HandoffLimit } from "../../../../platform/shared/index.ts";
import type { Settings } from "./settings.ts";

const UNKNOWN_LIMIT = 0;

export type StepLimit = HandoffLimit & {
  ceiling: number;
  graceTurns: number;
  maxTurnsAfterRequest: number;
};

type LimitState = { requested: boolean; turnsSinceRequest: number };

type LimitStep = "none" | "request" | "abort";

export const effectiveContextLimit = (limit: number, window: number, reserveTokens: number) => {
  if (window <= 0 || limit <= UNKNOWN_LIMIT) {
    return limit;
  }

  return Math.max(1, Math.min(limit, window - reserveTokens));
};

export const agentLimit = (
  definitionLimit: number,
  window: number,
  settings: Pick<Settings, "reserveTokens" | "softContextRatio" | "hardContextRatio">,
): StepLimit => {
  const request = effectiveContextLimit(definitionLimit, window, settings.reserveTokens);

  return {
    request,
    warn: request * settings.softContextRatio,
    ceiling: request * settings.hardContextRatio,
    graceTurns: 2,
    maxTurnsAfterRequest: 3,
  };
};

const shouldAbort = (tokens: number, limit: StepLimit, turnsSinceRequest: number) => {
  const ceilingAbort = tokens >= limit.ceiling && turnsSinceRequest >= limit.graceTurns;

  return ceilingAbort || turnsSinceRequest >= limit.maxTurnsAfterRequest;
};

export const limitStep = (tokens: number, limit: StepLimit, state: LimitState): LimitStep => {
  if (state.requested) {
    return shouldAbort(tokens, limit, state.turnsSinceRequest) ? "abort" : "none";
  }

  return tokens >= limit.request ? "request" : "none";
};
