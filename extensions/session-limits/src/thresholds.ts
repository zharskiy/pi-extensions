import type { ContextSnapshot, ThemeToken } from "./adapter/contract.ts";

export const MAX_INSTRUCTIONS = 2;

export type ContextLevel = "unknown" | "normal" | "soft" | "hard";

export type Phase = "watching" | "requested" | "waiting" | "switching" | "stuck";

export type HandoffFile = { kind: "missing" } | { kind: "invalid"; errors: string[] } | { kind: "valid" };

export type HandoffStep = "none" | "wait" | "switch" | "resend" | "give-up";

export type Ratios = { softRatio: number; hardRatio: number };

export type Segment = { token: ThemeToken; text: string };

export const percentOf = (context: ContextSnapshot) =>
  context.tokens === null || context.window <= 0 ? null : Math.round((context.tokens / context.window) * 100);

export const contextLevel = (context: ContextSnapshot, ratios: Ratios): ContextLevel => {
  if (context.tokens === null || context.window <= 0) {
    return "unknown";
  }

  if (context.tokens >= context.window * ratios.hardRatio) {
    return "hard";
  }

  return context.tokens >= context.window * ratios.softRatio ? "soft" : "normal";
};

export const shouldRequest = (phase: Phase, level: ContextLevel) => phase === "watching" && level === "hard";

export const isPending = (phase: Phase) => phase === "requested" || phase === "waiting";

export type HandoffInput = {
  phase: Phase;
  file: HandoffFile;
  busy: boolean;
  settled: boolean;
  instructions: number;
};

export const handoffStep = (input: HandoffInput): HandoffStep => {
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

export const pendingLabels = (command: string): Record<Exclude<Phase, "watching">, string> => ({
  requested: "writing handoff",
  waiting: "handoff waits for running work",
  switching: "switching session",
  stuck: `handoff failed, run /${command}`,
});

export const segmentFor = (
  context: ContextSnapshot,
  phase: Phase,
  ratios: Ratios,
  command: string,
): Segment | undefined => {
  const percent = percentOf(context);

  if (phase !== "watching") {
    const shown = percent === null ? "ctx" : `ctx ${percent}%`;

    return { token: "error", text: `${shown} · ${pendingLabels(command)[phase]}` };
  }

  const level = contextLevel(context, ratios);

  if (level === "unknown" || level === "normal") {
    return undefined;
  }

  return { token: "warning", text: `ctx ${percent}% · handoff at ${Math.round(ratios.hardRatio * 100)}%` };
};

export const retryInstruction = (instruction: string, errors: string[]) =>
  [
    instruction,
    "",
    "The previous handoff file was not accepted:",
    ...errors.map((error) => `- ${error}`),
    "Write the whole file again with these problems fixed.",
  ].join("\n");
