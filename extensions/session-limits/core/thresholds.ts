import type { ContextSnapshot } from "../../../platform/pi-adapter/index.ts";
import {
  type BudgetLevel,
  budgetLevel,
  type HandoffBudget,
  type Limits,
  thresholdsFor,
} from "../../../platform/shared/index.ts";

export type ContextTokens = Pick<ContextSnapshot, "tokens" | "window">;

export const MAX_INSTRUCTIONS = 2;

export type Phase = "watching" | "queued" | "requested" | "waiting" | "switching" | "stuck";

export type HandoffFile = { kind: "missing" } | { kind: "invalid"; errors: string[] } | { kind: "valid" };

const mainBudget = (window: number, limits: Limits): HandoffBudget | undefined => {
  if (window <= 0) {
    return undefined;
  }

  const { soft, hard } = thresholdsFor(window, limits);

  return { request: hard, warn: soft };
};

export const contextLevel = (context: ContextTokens, limits: Limits): BudgetLevel =>
  budgetLevel(context.tokens, mainBudget(context.window, limits));

export const shouldRequest = (phase: Phase, level: BudgetLevel) => phase === "watching" && level === "hard";

export const isPending = (phase: Phase) => phase === "requested" || phase === "waiting";

type HandoffInput = {
  phase: Phase;
  file: HandoffFile;
  busy: boolean;
  settled: boolean;
  instructions: number;
};

export const handoffStep = (input: HandoffInput) => {
  if (!isPending(input.phase)) {
    return "none";
  }

  if (input.file.kind === "valid") {
    return input.busy ? "wait" : "switch";
  }

  if (!input.settled) {
    return "none";
  }

  return input.instructions < MAX_INSTRUCTIONS ? "resend" : "give-up";
};
