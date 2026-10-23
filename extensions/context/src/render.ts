import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { cachePercentText } from "../../../core/manager/cache.ts";
import { formatTokens } from "../../../core/manager/format.ts";
import { DOT, PAD } from "../../../core/manager/layout.ts";
import { bullet } from "../../../core/manager/row.ts";
import {
  type CacheFigures,
  type Category,
  type CategoryKey,
  type UsageModel,
  usageModel,
} from "./breakdown.ts";
import { detailLines } from "./details.ts";
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

const headerText = (theme: ThemeLike, model: UsageModel) =>
  [
    theme.fg("text", modelName(model)),
    figuresText(model),
    ...(model.estimated ? [theme.fg("dim", "estimated")] : []),
  ].join(theme.fg("dim", DOT));

const lastTurnText = (theme: ThemeLike, lastTurn: number, missed: boolean) =>
  missed ? theme.fg("warning", `${Math.round(lastTurn)}%`) : cachePercentText(theme, lastTurn);

const cacheText = (theme: ThemeLike, cache: CacheFigures) => {
  const last =
    cache.lastTurn === undefined
      ? []
      : [`last turn ${lastTurnText(theme, cache.lastTurn, cache.lastMissed)}`];

  return `Cache hit: ${[...last, `session ${cachePercentText(theme, cache.session)}`].join(theme.fg("dim", DOT))}`;
};

const sideLines = (theme: ThemeLike, model: UsageModel) => [
  headerText(theme, model),
  ...(model.cache ? [cacheText(theme, model.cache)] : []),
  "",
  theme.bold("Estimated usage by category"),
  ...model.categories.map((category) => legendLine(theme, category, model.full)),
];

const indented = (line: string) => (line ? `${PAD}${line}` : line);

const bodyLines = (theme: ThemeLike, model: UsageModel, width: number) => {
  const side = sideLines(theme, model);
  const grid = gridOf(theme, model, width, Math.max(...side.map((line) => theme.width(line))));

  if (!grid.beside) {
    return [...grid.rows.map(indented), "", ...side.map(indented)];
  }

  const blank = " ".repeat(grid.columns * 2 - 1);

  return Array.from({ length: Math.max(grid.rows.length, side.length) }, (_, index) => {
    const right = side[index] ?? "";
    const left = grid.rows[index];

    if (left === undefined) {
      return right ? `${PAD}${blank}${GAP}${right}` : "";
    }

    return right ? `${PAD}${left}${GAP}${right}` : `${PAD}${left}`;
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
        `${PAD}${theme.fg("error", `Context exceeds the window by ${formatTokens(model.overflow)} tokens${DOT}/compact`)}`,
      ]
    : [];

const toggleLines = (theme: ThemeLike, snapshot: Snapshot, options: RenderOptions) => {
  if (snapshot.expandedByDefault || options.expanded) {
    return [];
  }

  return [`${PAD}${theme.fg("dim", `(${options.expandKey} expand)`)}`];
};

const titleLine = (theme: ThemeLike, stamp: string | undefined) =>
  `${bullet("text", theme)} ${theme.bold("Context Usage")}${stamp ? theme.fg("dim", `${DOT}${stamp}`) : ""}`;

const hung = (line: string) => (line ? ` ${line}` : line);

export const renderSnapshot = (theme: ThemeLike, snapshot: Snapshot, options: RenderOptions): string[] => {
  const model = usageModel(snapshot);
  const details = detailLines(theme, snapshot.breakdown, options.expanded || snapshot.expandedByDefault);
  const stamp = snapshot.timestamp > 0 ? clockText(snapshot.timestamp) : undefined;
  const footer = details.length > 0 ? ["", ...details, ...toggleLines(theme, snapshot, options)] : [];
  const body = [
    ...bodyLines(theme, model, Math.max(1, options.width - 1)),
    ...overflowLines(theme, model),
    ...footer,
  ];

  return [titleLine(theme, stamp), ...body.map(hung)];
};
