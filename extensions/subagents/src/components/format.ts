import type { ThemeLike } from "../../../../core/adapter/contract.ts";
import { type ReceiptFacts, type ReceiptSegment, receipt } from "../../../../core/manager/format.ts";
import type { AgentRecord } from "../model/types.ts";
import { displayWord, isStarting } from "./state-text.ts";

export { errorText, formatDuration, formatTokens } from "../../../../core/manager/format.ts";

export const SEP = " · ";

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const formatToolUses = (n: number): string => plural(n, "tool use");

export const formatCtx = (percent: number | null | undefined): string | undefined =>
  percent === null || percent === undefined ? undefined : `${Math.round(percent)}% context`;

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

export type ReceiptOptions = { live: boolean; reason?: string };

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
    return { word, running: true, elapsedMs: elapsedOf(record, now) };
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

type Painted = readonly [text: string, paint: (text: string) => string];

export const truncatePainted = (theme: ThemeLike, parts: readonly Painted[], cols: number): string => {
  const cut = theme.truncate(parts.map(([text]) => text).join(""), cols);
  const starts = parts.reduce<number[]>(
    (acc, [text]) => {
      acc.push((acc.at(-1) ?? 0) + text.length);

      return acc;
    },
    [0],
  );

  return parts
    .map(([, paint], index) => {
      const piece = cut.slice(starts[index], starts[index + 1]);

      return piece ? paint(piece) : "";
    })
    .join("");
};

export const padEndCols = (theme: ThemeLike, text: string, cols: number): string =>
  text + " ".repeat(Math.max(0, cols - theme.width(text)));

export const PAD = " ";

export const innerWidth = (width: number): number => Math.max(1, width - 2 * PAD.length);

export const alignRight = (
  theme: ThemeLike,
  left: string,
  right: string,
  cols: number,
): string | undefined =>
  theme.width(left) + 2 + theme.width(right) > cols
    ? undefined
    : padEndCols(theme, left, cols - theme.width(right)) + right;

const graphemes = new Intl.Segmenter();

export const wrapCols = (theme: ThemeLike, line: string, cols: number): string[] =>
  Array.from(graphemes.segment(line), ({ segment }) => segment).reduce<{ lines: string[]; used: number }>(
    (acc, grapheme) => {
      const width = theme.width(grapheme);

      if (acc.used + width > cols && acc.used > 0) {
        acc.lines.push(grapheme);

        return { lines: acc.lines, used: width };
      }

      acc.lines[acc.lines.length - 1] += grapheme;

      return { lines: acc.lines, used: acc.used + width };
    },
    { lines: [""], used: 0 },
  ).lines;
