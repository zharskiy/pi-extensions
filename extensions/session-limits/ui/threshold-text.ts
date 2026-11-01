import type { ThemeToken } from "../../../platform/pi-adapter/index.ts";
import { DOT, type Limits, limitLevel, mainLimit } from "../../../platform/shared/index.ts";
import { handoffNotice, MARKS, showsHandoffNotice } from "../../../platform/ui-kit/index.ts";
import type { ContextTokens } from "../core/thresholds.ts";

export const segmentFor = (
  context: ContextTokens | undefined,
  stuck: boolean,
  limits: Limits,
  command: string,
): { token: ThemeToken; text: string } | undefined => {
  if (stuck) {
    return { token: "error", text: `${MARKS.error} handoff failed${DOT}run /${command}` };
  }

  if (!context || context.tokens === null) {
    return undefined;
  }

  const limit = mainLimit(context.window, limits);

  if (!limit || !showsHandoffNotice(limitLevel(context.tokens, limit))) {
    return undefined;
  }

  return handoffNotice(context.tokens, limit.request);
};
