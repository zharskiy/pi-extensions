type ContextStep = "none" | "warn" | "handoff" | "abort";

const MAX_TURNS_AFTER_HANDOFF = 3;

type ContextStepInput = {
  tokens: number;
  limit: number;
  softRatio: number;
  hardRatio: number;
  warned: boolean;
  handoffRequested: boolean;
  turnsSinceHandoff: number;
};

export const contextStep = (input: ContextStepInput): ContextStep => {
  if (input.handoffRequested) {
    const overHard = input.tokens >= input.limit * input.hardRatio;
    const tooManyTurns = input.turnsSinceHandoff >= MAX_TURNS_AFTER_HANDOFF;
    const graceUsed = input.turnsSinceHandoff >= 2;

    return (overHard && graceUsed) || tooManyTurns ? "abort" : "none";
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
