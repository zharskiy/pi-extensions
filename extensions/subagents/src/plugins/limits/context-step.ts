type ContextStep = "none" | "warn" | "handoff" | "abort";

type ContextStepInput = {
  tokens: number;
  limit: number;
  softRatio: number;
  hardRatio: number;
  warned: boolean;
  handoffRequested: boolean;
  turnsSinceHandoff: number;
  maxTurnsAfterHandoff: number;
};

export const contextStep = (input: ContextStepInput): ContextStep => {
  if (input.handoffRequested) {
    const overHard = input.tokens >= input.limit * input.hardRatio;
    const tooManyTurns = input.turnsSinceHandoff >= input.maxTurnsAfterHandoff;

    return overHard || tooManyTurns ? "abort" : "none";
  }

  if (input.tokens >= input.limit) {
    return "handoff";
  }

  if (!input.warned && input.tokens >= input.limit * input.softRatio) {
    return "warn";
  }

  return "none";
};

export const softWarning = (tokens: number, limit: number) =>
  `Context limit warning: about ${Math.round((tokens / limit) * 100)}% of your ${limit}-token context limit is used. Finish the current step, avoid reading large files, and prepare to wrap up.`;
