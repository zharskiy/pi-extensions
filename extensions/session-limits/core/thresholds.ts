import type { ContextSnapshot } from "../../../platform/pi-adapter/index.ts";
import type { HandoffValidation, LimitLevel } from "../../../platform/shared/index.ts";

export type ContextTokens = Pick<ContextSnapshot, "tokens" | "window">;

export const MAX_INSTRUCTIONS = 2;

export type Phase = "watching" | "queued" | "requested" | "waiting" | "switching" | "stuck";

export const shouldRequest = (phase: Phase, level: LimitLevel) => phase === "watching" && level === "hard";

export const isPending = (phase: Phase) => phase === "requested" || phase === "waiting";

type HandoffInput = {
  phase: Phase;
  saved: HandoffValidation | undefined;
  busy: boolean;
  settled: boolean;
  instructions: number;
};

export const handoffStep = (input: HandoffInput) => {
  if (!isPending(input.phase)) {
    return "none";
  }

  if (input.saved?.ok) {
    return input.busy ? "wait" : "switch";
  }

  if (!input.settled) {
    return "none";
  }

  return input.instructions < MAX_INSTRUCTIONS ? "resend" : "give-up";
};
