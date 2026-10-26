import type { ThemeToken } from "../../../platform/pi-adapter/index.ts";
import { budgetLevel, DOT, formatTokens, formatWindow, type Limits } from "../../../platform/shared/index.ts";
import { MARKS } from "../../../platform/ui-kit/index.ts";
import { type ContextTokens, mainBudget } from "../core/thresholds.ts";

const notice = (text: string) => ({ token: "warning" as const, text: `${MARKS.info} ${text}` });

export const segmentFor = (
  context: ContextTokens | undefined,
  stuck: boolean,
  limits: Limits,
  command: string,
): { token: ThemeToken; text: string } | undefined => {
  if (stuck) {
    return { token: "error", text: `${MARKS.error} Handoff failed${DOT}run /${command}` };
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
