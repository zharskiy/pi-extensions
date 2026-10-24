import type { ContextSnapshot } from "../../../platform/pi-adapter/index.ts";

export type ContextTokens = Pick<ContextSnapshot, "tokens" | "window">;

export const MAX_INSTRUCTIONS = 2;

type ContextLevel = "unknown" | "normal" | "soft" | "hard";

export type Phase = "watching" | "queued" | "requested" | "waiting" | "switching" | "stuck";

export type HandoffFile = { kind: "missing" } | { kind: "invalid"; errors: string[] } | { kind: "valid" };

export type Limits = { softRatio: number; hardRatio: number; softTokens: number; hardTokens: number };

export const thresholdsFor = (window: number, limits: Limits) => ({
  soft: Math.min(window * limits.softRatio, limits.softTokens),
  hard: Math.min(window * limits.hardRatio, limits.hardTokens),
});

export const contextLevel = (context: ContextTokens, limits: Limits): ContextLevel => {
  if (context.tokens === null || context.window <= 0) {
    return "unknown";
  }

  const { soft, hard } = thresholdsFor(context.window, limits);

  if (context.tokens >= hard) {
    return "hard";
  }

  return context.tokens >= soft ? "soft" : "normal";
};

export const shouldRequest = (phase: Phase, level: ContextLevel) => phase === "watching" && level === "hard";

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

export const retryInstruction = (instruction: string, errors: string[]) =>
  [
    instruction,
    "",
    "The previous handoff file was not accepted:",
    ...errors.map((error) => `- ${error}`),
    "Write the whole file again with these problems fixed.",
  ].join("\n");
