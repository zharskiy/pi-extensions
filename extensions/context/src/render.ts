import { CHILD_COLUMN, type ThemeLike } from "../../../pi-adapter/index.ts";
import { DOT, formatTokens } from "../../../shared/index.ts";
import { cachePercentText, countLine, markGlyph } from "../../../ui-kit/index.ts";
import {
  type CacheFigures,
  type Category,
  type CategoryKey,
  type UsageModel,
  usageModel,
} from "./breakdown.ts";
import { detailLines, itemCount } from "./details.ts";
import { GAP, gridOf, legendGlyph } from "./grid.ts";
import type { Snapshot } from "./snapshot.ts";
import { figuresText, modelName } from "./summary.ts";

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

const percentText = (percent: number) => `${percent.toFixed(1)}%`;

const legendText = (theme: ThemeLike, category: Category, full: boolean) => {
  const amount = formatTokens(category.tokens);
  const share = `(${percentText(category.percent)})`;

  if (category.key !== "free") {
    return `${LABELS[category.key]}: ${amount} tokens ${share}`;
  }

  return full ? theme.fg("warning", `${LABELS.free}: 0 (0%)`) : `${LABELS.free}: ${amount} ${share}`;
};

const legendLine = (theme: ThemeLike, category: Category, full: boolean) =>
  `${legendGlyph(theme, category.key)} ${legendText(theme, category, full)}`;

const headerText = (theme: ThemeLike, model: UsageModel, unit: boolean) =>
  [
    theme.fg("text", modelName(model)),
    figuresText(model, unit),
    ...(model.estimated ? [theme.fg("dim", "estimated")] : []),
  ].join(theme.fg("dim", DOT));

const fittedHeader = (theme: ThemeLike, model: UsageModel, room: number) => {
  const full = headerText(theme, model, true);

  return theme.width(full) <= room ? full : headerText(theme, model, false);
};

const lastTurnText = (theme: ThemeLike, lastTurn: number, missed: boolean) =>
  missed ? theme.fg("warning", `${Math.round(lastTurn)}%`) : cachePercentText(theme, lastTurn);

const cacheText = (theme: ThemeLike, cache: CacheFigures) => {
  const last =
    cache.lastTurn === undefined
      ? []
      : [`last turn ${lastTurnText(theme, cache.lastTurn, cache.lastMissed)}`];

  return `Cache hit: ${[...last, `session ${cachePercentText(theme, cache.session)}`].join(theme.fg("dim", DOT))}`;
};

const sideLines = (theme: ThemeLike, model: UsageModel, room: number) => [
  fittedHeader(theme, model, room),
  ...(model.cache ? [cacheText(theme, model.cache)] : []),
  "",
  theme.bold("Estimated usage by category"),
  ...model.categories.map((category) => legendLine(theme, category, model.full)),
];

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

const titleLine = (theme: ThemeLike, stamp: string | undefined) =>
  `${markGlyph("info", theme)} ${theme.bold("Context usage")}${stamp ? theme.fg("dim", `${DOT}${stamp}`) : ""}`;

const indented = (line: string) => (line ? `${INDENT}${line}` : line);

export const renderSnapshot = (theme: ThemeLike, snapshot: Snapshot, options: RenderOptions): string[] => {
  const model = usageModel(snapshot);
  const details = detailLines(theme, snapshot.breakdown, options.expanded || snapshot.expandedByDefault);
  const stamp = snapshot.timestamp > 0 ? clockText(snapshot.timestamp) : undefined;
  const footer = details.length > 0 ? ["", ...details, ...countLines(theme, snapshot, options)] : [];
  const body = [...bodyLines(theme, model, options.width), ...overflowLines(theme, model), ...footer];

  return [titleLine(theme, stamp), ...body.map(indented)].map((line) =>
    line === "" ? line : theme.truncate(line, Math.max(1, options.width)),
  );
};
