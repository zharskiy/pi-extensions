import type { ThemeToken } from "../../../pi-adapter/index.ts";
import { DOT, formatTokens, formatWindow } from "../../../shared/index.ts";
import { MARKS } from "../../../ui-kit/index.ts";
import {
  type ContextTokens,
  contextLevel,
  type Limits,
  type Phase,
  thresholdsFor,
} from "../core/thresholds.ts";

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

  const level = contextLevel(context, limits);

  if (level === "normal") {
    return undefined;
  }

  const { hard } = thresholdsFor(context.window, limits);

  return notice(`Handoff at ${formatWindow(hard)} tokens${DOT}${formatTokens(context.tokens)} used`);
};
