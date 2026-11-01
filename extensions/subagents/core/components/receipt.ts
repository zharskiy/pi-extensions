import type { ThemeToken } from "../../../../platform/pi-adapter/index.ts";
import { counted, DOT, formatCost, formatDuration, formatTokens } from "../../../../platform/shared/index.ts";
import type { AgentRecord, AgentState } from "../model/agent-record.ts";

export const formatCalls = (count: number): string => counted(count, "call");

export type ReceiptKind = "word" | "reason" | "time" | "calls" | "tokens" | "cost" | "activity" | "context";

export type ReceiptSegment = { kind: ReceiptKind; text: string; token: ThemeToken; painted?: string };

type ReceiptFacts = {
  word?: string;
  reason?: string;
  elapsedMs?: number;
  running: boolean;
  calls?: number;
  tokens?: number;
  cost?: number;
  activity?: string;
};

const STOPPED_WORD = "Stopped";

const DISPLAY_WORDS: Partial<Record<AgentState, string>> = {
  queued: "Queued",
  grace: "Stopping",
  stopped: "Stopped",
  handoff: "Handed off",
};

const STARTING = "Starting";

const isStarting = (record: Pick<AgentRecord, "state" | "turns" | "toolCalls" | "activity">) =>
  record.state === "running" && record.turns === 0 && record.toolCalls === 0 && !record.activity;

export const displayWord = (
  record: Pick<AgentRecord, "state" | "turns" | "toolCalls" | "activity">,
): string | undefined => (isStarting(record) ? STARTING : DISPLAY_WORDS[record.state]);

const callsText = (facts: ReceiptFacts) => {
  if (facts.calls === undefined || (facts.calls === 0 && facts.word !== STOPPED_WORD)) {
    return undefined;
  }

  return formatCalls(facts.calls);
};

const timeText = (facts: ReceiptFacts) => {
  if (facts.elapsedMs === undefined) {
    return undefined;
  }

  const duration = formatDuration(facts.elapsedMs);

  return facts.running ? `Elapsed ${duration}` : duration;
};

export const receipt = (facts: ReceiptFacts): ReceiptSegment[] => {
  const segments: [ReceiptKind, string | undefined, ThemeToken][] = [
    ["word", facts.word, "muted"],
    ["reason", facts.reason, "error"],
    ["time", timeText(facts), "muted"],
    ["calls", callsText(facts), "muted"],
    ["tokens", facts.tokens ? `${formatTokens(facts.tokens)} tokens` : undefined, "muted"],
    ["cost", facts.cost === undefined ? undefined : formatCost(facts.cost), "muted"],
    ["activity", facts.activity || undefined, "muted"],
  ];

  return segments
    .filter((entry): entry is [ReceiptKind, string, ThemeToken] => entry[1] !== undefined && entry[1] !== "")
    .map(([kind, text, token]) => ({ kind, text, token }));
};

export const plainReceipt = (segments: readonly ReceiptSegment[]) =>
  segments.map((part) => part.text).join(DOT);

export const singleLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

export const elapsedOf = (
  record: { startedAt?: number; createdAt: number; endedAt?: number },
  now: number,
): number => (record.endedAt ?? now) - (record.startedAt ?? record.createdAt);

type ReceiptRecord = Pick<
  AgentRecord,
  "state" | "turns" | "toolCalls" | "tokens" | "cost" | "activity" | "createdAt" | "startedAt" | "endedAt"
>;

type ReceiptOptions = { live: boolean; reason?: string };

const figures = (record: ReceiptRecord, now: number) => ({
  elapsedMs: elapsedOf(record, now),
  calls: record.toolCalls,
  tokens: record.tokens,
  cost: record.cost,
});

const receiptFacts = (record: ReceiptRecord, now: number, options: ReceiptOptions): ReceiptFacts => {
  const word = displayWord(record);

  if (record.state === "queued" || isStarting(record)) {
    return { word, running: false };
  }

  if (record.state === "grace") {
    return options.live
      ? { word, running: true, elapsedMs: elapsedOf(record, now) }
      : { word, running: false };
  }

  if (record.state === "running") {
    return options.live
      ? { ...figures(record, now), running: true, activity: record.activity }
      : { word: "Running", running: false };
  }

  return { ...figures(record, now), word, reason: options.reason, running: false };
};

export const agentReceipt = (record: ReceiptRecord, now: number, options: ReceiptOptions): ReceiptSegment[] =>
  receipt(receiptFacts(record, now, options));

export const cutChars = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
