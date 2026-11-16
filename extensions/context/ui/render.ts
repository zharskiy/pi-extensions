import { CHILD_COLUMN, type ThemeLike } from "../../../platform/pi-adapter/index.ts";
import { DOT, formatPercent, formatTokens } from "../../../platform/shared/index.ts";
import { cachePercentText, countLine, markGlyph } from "../../../platform/ui-kit/index.ts";
import { type Category, type CategoryKey, type UsageModel, usageModel } from "../core/breakdown.ts";
import type { Snapshot } from "../core/snapshot.ts";
import { detailLines, itemCount } from "./details.ts";
import { GAP, gridOf, legendGlyph } from "./grid.ts";
import { cacheText, headerText, type SummaryPaint } from "./summary.ts";

type RenderOptions = { width: number; expanded: boolean; expandKey: string };

const LABELS: Record<CategoryKey, string> = {
  systemPrompt: "System prompt",
  systemTools: "System tools",
  mcpTools: "MCP tools",
  extensionTools: "Extension tools",
  memoryFiles: "Memory files",
  skills: "Skills",
  messages: "Messages",
  free: "Free space",
  reserve: "Compaction reserve",
};

const INDENT = " ".repeat(CHILD_COLUMN);

const legendText = (theme: ThemeLike, category: Category, full: boolean) => {
  const amount = formatTokens(category.tokens);
  const share = `(${formatPercent(category.percent, 1)})`;

  if (category.key !== "free") {
    return `${LABELS[category.key]}: ${amount} tokens ${share}`;
  }

  return full ? theme.fg("warning", `${LABELS.free}: 0 (0%)`) : `${LABELS.free}: ${amount} ${share}`;
};

const legendLine = (theme: ThemeLike, category: Category, full: boolean) =>
  `${legendGlyph(theme, category.key)} ${legendText(theme, category, full)}`;

const painted = (theme: ThemeLike): SummaryPaint => ({
  name: (text) => theme.fg("text", text),
  note: (text) => theme.fg("dim", text),
  percent: (value, missed) =>
    missed ? theme.fg("warning", formatPercent(value)) : cachePercentText(theme, value),
  dot: theme.fg("dim", DOT),
});

const fittedHeader = (theme: ThemeLike, model: UsageModel, room: number, paint: SummaryPaint) => {
  const full = headerText(model, true, paint);

  return theme.width(full) <= room ? full : headerText(model, false, paint);
};

const sideLines = (theme: ThemeLike, model: UsageModel, room: number) => {
  const paint = painted(theme);

  return [
    fittedHeader(theme, model, room, paint),
    ...(model.cache ? [cacheText(model.cache, paint)] : []),
    "",
    theme.bold("Estimated usage by category"),
    ...model.categories.map((category) => legendLine(theme, category, model.full)),
  ];
};

const bodyLines = (theme: ThemeLike, model: UsageModel, width: number) => {
  const room = Math.max(1, width - CHILD_COLUMN);
  const side = sideLines(theme, model, room);
  const grid = gridOf(theme, model, width, room, Math.max(...side.map((line) => theme.width(line))));

  if (!grid.beside) {
    return [...grid.rows, ...side];
  }

  const blank = " ".repeat(grid.columns * 2 - 1);

  return Array.from({ length: Math.max(grid.rows.length, side.length) }, (_, index) => {
    const right = side[index] ?? "";
    const left = grid.rows[index];

    if (left === undefined) {
      return right ? `${blank}${GAP}${right}` : "";
    }

    return right ? `${left}${GAP}${right}` : left;
  });
};

const twoDigits = (value: number) => `${value}`.padStart(2, "0");

const clockText = (timestamp: number) => {
  const date = new Date(timestamp);

  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
};

const overflowLines = (theme: ThemeLike, model: UsageModel) =>
  model.overflow > 0
    ? [
        theme.fg(
          "error",
          `Context exceeds the window by ${formatTokens(model.overflow)} tokens${DOT}/compact`,
        ),
      ]
    : [];

const countLines = (theme: ThemeLike, snapshot: Snapshot, options: RenderOptions) => {
  const hidden = itemCount(snapshot.breakdown);

  if (snapshot.expandedByDefault || options.expanded || hidden === 0) {
    return [];
  }

  const room = Math.max(1, options.width - CHILD_COLUMN);

  return [countLine({ hidden, end: "more", noun: "item", key: options.expandKey }, room, theme)];
};

const titleLine = (theme: ThemeLike, stamp: string) =>
  `${markGlyph("info", theme)} ${theme.bold("Context usage")}${theme.fg("dim", `${DOT}${stamp}`)}`;

const indented = (line: string) => (line ? `${INDENT}${line}` : line);

export const renderSnapshot = (theme: ThemeLike, snapshot: Snapshot, options: RenderOptions): string[] => {
  const model = usageModel(snapshot);
  const details = detailLines(theme, snapshot.breakdown, options.expanded || snapshot.expandedByDefault);
  const stamp = clockText(snapshot.timestamp);
  const footer = details.length > 0 ? ["", ...details, ...countLines(theme, snapshot, options)] : [];
  const body = [...bodyLines(theme, model, options.width), ...overflowLines(theme, model), ...footer];

  return [titleLine(theme, stamp), ...body.map(indented)].map((line) =>
    line === "" ? line : theme.truncate(line, Math.max(1, options.width)),
  );
};
