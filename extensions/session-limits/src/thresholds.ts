import type { ContextSnapshot, ThemeToken } from "../../../core/adapter/contract.ts";
import { formatWindow } from "../../../core/manager/format.ts";

type ContextTokens = Pick<ContextSnapshot, "tokens" | "window">;

export const MAX_INSTRUCTIONS = 2;

type ContextLevel = "unknown" | "normal" | "soft" | "hard";

export type Phase = "watching" | "queued" | "requested" | "waiting" | "switching" | "stuck";

export type HandoffFile = { kind: "missing" } | { kind: "invalid"; errors: string[] } | { kind: "valid" };

export type Limits = { softRatio: number; hardRatio: number; softTokens: number; hardTokens: number };

const percentOf = (context: ContextTokens) =>
  context.tokens === null || context.window <= 0 ? null : Math.floor((context.tokens * 100) / context.window);

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

const pendingLabels = (command: string): Record<Exclude<Phase, "watching">, string> => ({
  queued: "handoff after this turn",
  requested: "writing handoff",
  waiting: "handoff waits for running work",
  switching: "switching session",
  stuck: `handoff failed, run /${command}`,
});

export const segmentFor = (
  context: ContextTokens | undefined,
  phase: Phase,
  limits: Limits,
  command: string,
): { token: ThemeToken; text: string } | undefined => {
  const percent = context ? percentOf(context) : null;

  if (phase !== "watching") {
    const label = pendingLabels(command)[phase];

    return {
      token: phase === "waiting" || phase === "queued" ? "warning" : "error",
      text: percent === null ? label : `ctx ${percent}% · ${label}`,
    };
  }

  if (!context) {
    return undefined;
  }

  const level = contextLevel(context, limits);

  if (level === "unknown" || level === "normal") {
    return undefined;
  }

  const text =
    context.window * limits.hardRatio <= limits.hardTokens
      ? `ctx ${percent}% · handoff at ${Math.round(limits.hardRatio * 100)}%`
      : `ctx ${formatWindow(context.tokens ?? 0)} · handoff at ${formatWindow(limits.hardTokens)}`;

  return { token: "warning", text };
};

export const retryInstruction = (instruction: string, errors: string[]) =>
  [
    instruction,
    "",
    "The previous handoff file was not accepted:",
    ...errors.map((error) => `- ${error}`),
    "Write the whole file again with these problems fixed.",
  ].join("\n");
