import type { AssistantEnd } from "../../../platform/pi-adapter/index.ts";
import { formatDuration, isFiniteNumber } from "../../../platform/shared/index.ts";

export type TurnWork = { startedAt: number; tools: number };

type AnswerData = { ms: number };

export const openTurn = (now: number): TurnWork => ({ startedAt: now, tools: 0 });

export const countTools = (work: TurnWork, info: AssistantEnd): TurnWork => ({
  ...work,
  tools: work.tools + info.toolCalls,
});

export const settledAnswer = (work: TurnWork, now: number): AnswerData | undefined => {
  const ms = now - work.startedAt;

  return work.tools > 0 && isFiniteNumber(ms) ? { ms } : undefined;
};

export const parseAnswer = (data: unknown): AnswerData | undefined => {
  const ms = (data as { ms?: unknown } | null)?.ms;

  return isFiniteNumber(ms) && ms >= 0 ? { ms } : undefined;
};

export const answerLabel = (data: AnswerData) => `worked ${formatDuration(data.ms)}`;
