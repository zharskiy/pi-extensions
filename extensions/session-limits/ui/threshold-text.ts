import type { ThemeToken } from "../../../platform/pi-adapter/index.ts";
import { DOT, type Limits, limitLevel, mainLimit } from "../../../platform/shared/index.ts";
import { handoffNotice, MARKS } from "../../../platform/ui-kit/index.ts";
import { HANDOFF_COMMAND } from "../core/handoff.ts";
import type { ContextTokens } from "../core/thresholds.ts";

export const segmentFor = (
  context: ContextTokens | undefined,
  stuck: boolean,
  limits: Limits,
): { token: ThemeToken; text: string } | undefined => {
  if (stuck) {
    return { token: "error", text: `${MARKS.error} handoff failed${DOT}run /${HANDOFF_COMMAND}` };
  }

  if (!context || context.tokens === null) {
    return undefined;
  }

  const limit = mainLimit(context.window, limits);

  return limit && handoffNotice(limitLevel(context.tokens, limit), context.tokens, limit.request);
};
