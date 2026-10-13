import type { PromptRecord, ThemeLike, TranscriptItem } from "../../../../core/adapter/contract.ts";
import { formatTokens } from "./format.ts";

type LimitTone = "success" | "warning" | "error";

type BreakdownRow = {
  label: string;
  tokens: number;
  estimated: boolean;
  tone: LimitTone;
  depth: number;
};

type ContextBreakdown = {
  rows: BreakdownRow[];
  limit: number;
  window: number;
  used: number;
  measured: boolean;
  free: number;
};

export type BreakdownInput = {
  prompt: PromptRecord;
  items: TranscriptItem[];
  measured?: number | null;
  limit: number;
  window: number;
  softRatio: number;
  estimate(text: string): number;
};

const SKILLS_SECTION = "skills";

const ESTIMATE_MARK = "~";

const BAR_CELLS = 20;

const LABEL_WIDTH = 16;

export const limitTone = (tokens: number, limit: number, softRatio: number): LimitTone => {
  if (limit <= 0) {
    return "success";
  }

  if (tokens >= limit) {
    return "error";
  }

  return tokens >= limit * softRatio ? "warning" : "success";
};

const itemText = (item: TranscriptItem) => {
  if (item.kind !== "assistant") {
    return item.text;
  }

  const calls = item.toolCalls.map((call) => `${call.name}${JSON.stringify(call.args) ?? ""}`);

  return [item.text, item.thinking ?? "", ...calls].join("");
};

const sumOf = (values: number[]) => values.reduce((total, value) => total + value, 0);

type MessageShare = "user" | "assistant" | "tool results";

const shareOf = (item: TranscriptItem): MessageShare => {
  if (item.kind === "assistant") {
    return "assistant";
  }

  return item.kind === "tool" ? "tool results" : "user";
};

export const contextBreakdown = (input: BreakdownInput): ContextBreakdown => {
  const { prompt, estimate, limit, softRatio } = input;
  const row = (label: string, tokens: number, depth = 0, estimated = true): BreakdownRow => ({
    label,
    tokens,
    estimated,
    tone: limitTone(tokens, limit, softRatio),
    depth,
  });

  const system = sumOf(
    prompt.sections
      .filter((section) => section.name !== SKILLS_SECTION)
      .map((section) => estimate(section.text)),
  );

  const tools = prompt.tools.length > 0 ? estimate(JSON.stringify(prompt.tools)) : 0;

  const skills = sumOf(
    prompt.sections
      .filter((section) => section.name === SKILLS_SECTION)
      .map((section) => estimate(section.text)),
  );

  const shares: Record<MessageShare, number> = { user: 0, assistant: 0, "tool results": 0 };

  input.items.forEach((item) => {
    shares[shareOf(item)] += estimate(itemText(item));
  });

  const messages = sumOf(Object.values(shares));
  const estimatedTotal = system + tools + skills + messages;
  const measured = typeof input.measured === "number" && input.measured > 0;
  const used = measured ? (input.measured as number) : estimatedTotal;
  const free = Math.max(0, limit - used);
  const usedTone = limitTone(used, limit, softRatio);

  const rows = [
    row("system prompt", system),
    row("tools", tools),
    row("skills", skills),
    row("messages", messages),
    row("user", shares.user, 1),
    row("assistant", shares.assistant, 1),
    row("tool results", shares["tool results"], 1),
    { ...row("used", used, 0, !measured), tone: usedTone },
    { ...row("free space", free, 0, !measured), tone: usedTone },
  ];

  return { rows, limit, window: input.window, used, measured, free };
};

const percentOf = (tokens: number, total: number) => (total > 0 ? (tokens / total) * 100 : 0);

const barText = (tokens: number, limit: number) => {
  const filled = Math.min(BAR_CELLS, Math.round((percentOf(tokens, limit) / 100) * BAR_CELLS));

  return { filled: "█".repeat(filled), empty: "░".repeat(BAR_CELLS - filled) };
};

export const limitLineText = (breakdown: ContextBreakdown) => {
  if (breakdown.limit <= 0) {
    return "limit unknown (the agent's file is gone)";
  }

  const limit = `limit ${formatTokens(breakdown.limit)} tokens`;

  if (breakdown.window <= 0) {
    return `${limit} (model window unknown)`;
  }

  const share = Math.round(percentOf(breakdown.limit, breakdown.window));

  return `${limit} (${share}% of the model window ${formatTokens(breakdown.window)})`;
};

const breakdownTitle = (breakdown: ContextBreakdown, hideHint: string) => {
  const source = breakdown.measured ? "used is measured" : "nothing measured yet";

  return `Context · ${ESTIMATE_MARK} marks estimates (characters / 4), ${source} · ${hideHint}`;
};

const rowLine = (entry: BreakdownRow, limit: number, theme: ThemeLike, width: number) => {
  const label = `${"  ".repeat(entry.depth + 1)}${entry.label}`.padEnd(LABEL_WIDTH);
  const figure = `${formatTokens(entry.tokens)}${entry.estimated ? ESTIMATE_MARK : " "}`.padStart(8);
  const percent = `${percentOf(entry.tokens, limit).toFixed(1)}%`.padStart(7);
  const head = `${label} ${figure}`;
  const bar = barText(entry.tokens, limit);
  const full = head.length + percent.length + 2 + BAR_CELLS;

  if (width < head.length + percent.length) {
    return head.slice(0, Math.max(0, width));
  }

  if (width < full) {
    return `${head}${theme.fg(entry.tone, percent)}`;
  }

  return `${head}${theme.fg(entry.tone, percent)}  ${theme.fg(entry.tone, bar.filled)}${theme.fg("dim", bar.empty)}`;
};

export const renderBreakdown = (
  breakdown: ContextBreakdown,
  theme: ThemeLike,
  width: number,
  hideHint: string,
) => {
  const rows = breakdown.rows.map((entry) => rowLine(entry, breakdown.limit, theme, width));
  const usedTone = breakdown.rows.find((entry) => entry.label === "used")?.tone ?? "success";

  return [
    theme.bold(breakdownTitle(breakdown, hideHint).slice(0, Math.max(0, width))),
    ...rows,
    theme.fg(usedTone, `  ${limitLineText(breakdown)}`.slice(0, Math.max(0, width))),
  ];
};
