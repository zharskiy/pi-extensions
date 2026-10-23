import type { ContextSnapshot, ThemeToken } from "../../../core/adapter/contract.ts";
import { formatTokens, formatWindow } from "../../../core/manager/format.ts";
import { MARKS } from "../../../core/manager/row.ts";

type ContextTokens = Pick<ContextSnapshot, "tokens" | "window">;

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

const SEP = " · ";

const pendingLabels: Record<Exclude<Phase, "watching" | "stuck">, string> = {
  queued: "Handoff after this turn",
  requested: "Handoff writing the document",
  waiting: "Handoff waiting for running work",
  switching: "Handoff switching to a new session",
};

const notice = (text: string) => ({ token: "warning" as const, text: `${MARKS.info} ${text}` });

export const segmentFor = (
  context: ContextTokens | undefined,
  phase: Phase,
  limits: Limits,
  command: string,
): { token: ThemeToken; text: string } | undefined => {
  if (phase === "stuck") {
    return { token: "error", text: `${MARKS.error} Handoff failed${SEP}run /${command}` };
  }

  if (phase !== "watching") {
    return notice(pendingLabels[phase]);
  }

  if (!context) {
    return undefined;
  }

  const level = contextLevel(context, limits);

  if (level === "unknown" || level === "normal") {
    return undefined;
  }

  const { hard } = thresholdsFor(context.window, limits);

  const used = context.tokens === null ? "" : `${SEP}${formatTokens(context.tokens)} used`;

  return notice(`Handoff at ${formatWindow(hard)} tokens${used}`);
};

export const retryInstruction = (instruction: string, errors: string[]) =>
  [
    instruction,
    "",
    "The previous handoff file was not accepted:",
    ...errors.map((error) => `- ${error}`),
    "Write the whole file again with these problems fixed.",
  ].join("\n");
