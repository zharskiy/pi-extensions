import { isAbsolute, relative, sep } from "node:path";
import type { ThemeLike, ThemeToken } from "../adapter/contract.ts";
import { DOT } from "./layout.ts";

export const formatTokens = (n: number): string => {
  if (n < 1_000) {
    return `${n}`;
  }

  const thousands = (n / 1_000).toFixed(1);

  if (Number(thousands) < 1_000) {
    return `${thousands}k`;
  }

  return `${(n / 1_000_000).toFixed(1)}M`;
};

export const formatWindow = (count: number): string => {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;

    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }

  return count >= 1_000 ? `${Math.round(count / 1_000)}k` : `${count}`;
};

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const homeRelative = (path: string, home: string): string =>
  home && (path === home || path.startsWith(`${home}${sep}`)) ? `~${path.slice(home.length)}` : path;

export const shortPath = (path: string, cwd: string, home: string): string => {
  if (cwd && isAbsolute(path) && (path === cwd || path.startsWith(`${cwd}${sep}`))) {
    return relative(cwd, path) || ".";
  }

  return homeRelative(path, home);
};

export const formatCost = (usd: number, options: { zero?: "omit" | "show" } = {}): string | undefined => {
  if (usd <= 0) {
    return options.zero === "show" ? "$0.00" : undefined;
  }

  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
};

export const noun = (count: number, word: string, plural = `${word}s`) => (count === 1 ? word : plural);

export const counted = (count: number, word: string, plural?: string) =>
  `${count} ${noun(count, word, plural)}`;

export const formatCalls = (count: number): string => counted(count, "call");

export type ReceiptKind = "word" | "reason" | "time" | "calls" | "tokens" | "cost" | "activity";

export type ReceiptSegment = { kind: ReceiptKind; text: string; token: ThemeToken };

export type ReceiptFacts = {
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

const DROP_ORDER: readonly ReceiptKind[] = ["activity", "cost", "calls", "tokens"];

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

export const fitReceipt = (segments: readonly ReceiptSegment[], room: number, theme: ThemeLike) =>
  DROP_ORDER.reduce<readonly ReceiptSegment[]>(
    (kept, kind) =>
      theme.width(plainReceipt(kept)) <= room ? kept : kept.filter((part) => part.kind !== kind),
    segments,
  );

export const receiptText = (segments: readonly ReceiptSegment[], room: number, theme: ThemeLike) =>
  fitReceipt(segments, room, theme)
    .map((part) => theme.fg(part.token, part.text))
    .join(theme.fg("muted", DOT));
