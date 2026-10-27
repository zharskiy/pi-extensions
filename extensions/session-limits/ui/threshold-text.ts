import type { ThemeToken } from "../../../platform/pi-adapter/index.ts";
import {
  DOT,
  formatTokens,
  formatWindow,
  type Limits,
  limitLevel,
  mainLimit,
} from "../../../platform/shared/index.ts";
import { MARKS } from "../../../platform/ui-kit/index.ts";
import type { ContextTokens } from "../core/thresholds.ts";

const notice = (text: string) => ({ token: "warning" as const, text: `${MARKS.info} ${text}` });

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

  if (!limit || limitLevel(context.tokens, limit) === "normal") {
    return undefined;
  }

  return notice(`handoff at ${formatWindow(limit.request)} tokens${DOT}${formatTokens(context.tokens)} used`);
};
