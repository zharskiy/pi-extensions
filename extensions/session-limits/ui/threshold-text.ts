import type { ThemeToken } from "../../../platform/pi-adapter/index.ts";
import { budgetLevel, DOT, formatTokens, formatWindow, type Limits } from "../../../platform/shared/index.ts";
import { MARKS } from "../../../platform/ui-kit/index.ts";
import { type ContextTokens, mainBudget, type Phase } from "../core/thresholds.ts";

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
    return { token: "error", text: `${MARKS.error} Handoff failed${DOT}run /${command}` };
  }

  if (phase !== "watching") {
    return notice(pendingLabels[phase]);
  }

  if (!context || context.tokens === null) {
    return undefined;
  }

  const budget = mainBudget(context.window, limits);

  if (!budget || budgetLevel(context.tokens, budget) === "normal") {
    return undefined;
  }

  return notice(
    `Handoff at ${formatWindow(budget.request)} tokens${DOT}${formatTokens(context.tokens)} used`,
  );
};
