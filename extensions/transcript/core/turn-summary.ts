import type { AssistantEnd } from "../../../platform/pi-adapter/index.ts";
import { formatDuration } from "../../../platform/shared/index.ts";

export type RunWork = { startedAt: number; tools: number };

type AnswerData = { ms: number };

export const startRun = (now: number): RunWork => ({ startedAt: now, tools: 0 });

export const afterMessage = (
  work: RunWork,
  info: AssistantEnd,
  now: number,
): { work: RunWork; entry?: AnswerData } => {
  const isFinal = info.toolCalls === 0 && info.stopReason === "stop" && info.text;

  if (isFinal && work.tools > 0) {
    return { work: startRun(now), entry: { ms: now - work.startedAt } };
  }

  return { work: { ...work, tools: work.tools + info.toolCalls } };
};

export const parseAnswer = (data: unknown): AnswerData | undefined => {
  const ms = (data as { ms?: unknown } | null)?.ms;

  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? { ms } : undefined;
};

export const answerLabel = (data: AnswerData) => `worked ${formatDuration(data.ms)}`;
