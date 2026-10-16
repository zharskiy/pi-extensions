import type { ContextBreakdown, ContextPart, ThemeLike, ThemeToken } from "../../../core/adapter/contract.ts";
import { cacheTone } from "../../../core/manager/cache.ts";
import { formatTokens } from "../../../core/manager/format.ts";
import {
  byTokens,
  type CacheFigures,
  type Category,
  type CategoryKey,
  type Cell,
  gridCells,
  type Snapshot,
  sumParts,
  type UsageModel,
  usageModel,
} from "./breakdown.ts";

const PAD = " ";

const GAP = "   ";

const DOT = " · ";

const NARROW_MAX = 50;

const WIDE_WINDOW = 1_000_000;

const COLORS: Record<CategoryKey, ThemeToken> = {
  systemPrompt: "syntaxComment",
  systemTools: "syntaxType",
  mcpTools: "syntaxFunction",
  extensionTools: "syntaxKeyword",
  memoryFiles: "syntaxString",
  skills: "syntaxNumber",
  messages: "accent",
  free: "dim",
  reserve: "warning",
};

const GLYPHS = { used: "⛁", partial: "⛀", free: "⛶", reserve: "⛝" } as const;

export type RenderOptions = { width: number; expanded: boolean; expandKey: string };

export type GridLayout = { columns: number; rows: number; beside: boolean };

const besideWidth = (columns: number, side: number) => PAD.length + columns * 2 - 1 + GAP.length + side;

export const gridLayout = (window: number, width: number, side: number): GridLayout => {
  if (width < NARROW_MAX) {
    return { columns: 5, rows: 5, beside: false };
  }

  if (window >= WIDE_WINDOW && besideWidth(20, side) <= width) {
    return { columns: 20, rows: 10, beside: true };
  }

  return { columns: 10, rows: 10, beside: besideWidth(10, side) <= width };
};

export const formatWindow = (count: number) => {
  if (count >= 1_000_000 && count % 100_000 === 0) {
    return `${count / 1_000_000}M`;
  }

  if (count >= 1_000 && count % 1_000 === 0) {
    return `${count / 1_000}k`;
  }

  return formatTokens(count);
};

const glyphOf = (key: CategoryKey, partial: boolean) => {
  if (key === "free") {
    return GLYPHS.free;
  }

  if (key === "reserve") {
    return GLYPHS.reserve;
  }

  return partial ? GLYPHS.partial : GLYPHS.used;
};

const paintCell = (theme: ThemeLike, cell: Cell) =>
  theme.fg(COLORS[cell.key], glyphOf(cell.key, cell.partial));

const gridRows = (theme: ThemeLike, cells: Cell[], columns: number) =>
  Array.from({ length: Math.ceil(cells.length / columns) }, (_, row) =>
    cells
      .slice(row * columns, (row + 1) * columns)
      .map((cell) => paintCell(theme, cell))
      .join(" "),
  );

const percentText = (percent: number) => `${percent.toFixed(1)}%`;

const legendLine = (theme: ThemeLike, category: Category, full: boolean) => {
  const glyph = theme.fg(COLORS[category.key], glyphOf(category.key, false));

  if (category.key === "free") {
    if (full) {
      return `${glyph} ${theme.fg("warning", "Free space: 0 (0%)")}`;
    }

    return `${glyph} ${category.label}: ${formatTokens(category.tokens)} (${percentText(category.percent)})`;
  }

  return `${glyph} ${category.label}: ${formatTokens(category.tokens)} tokens (${percentText(category.percent)})`;
};

export const headerText = (theme: ThemeLike, model: UsageModel) => {
  const mark = model.estimated ? "~" : "";
  const figures = `${mark}${formatTokens(model.used)}/${formatWindow(model.window)} tokens (${Math.round(model.percent)}%)`;

  return [
    theme.fg("text", model.model ?? "no model"),
    figures,
    ...(model.estimated ? [theme.fg("dim", "estimated")] : []),
  ].join(theme.fg("dim", DOT));
};

const hitText = (theme: ThemeLike, percent: number, token: ThemeToken) =>
  theme.fg(token, `${Math.round(percent)}%`);

export const cacheText = (theme: ThemeLike, cache: CacheFigures) => {
  const last =
    cache.lastTurn === undefined
      ? []
      : [
          `last turn ${hitText(theme, cache.lastTurn, cache.lastMissed ? "warning" : cacheTone(cache.lastTurn))}`,
        ];

  return `Cache hit: ${[...last, `session ${hitText(theme, cache.session, cacheTone(cache.session))}`].join(theme.fg("dim", DOT))}`;
};

const sideLines = (theme: ThemeLike, model: UsageModel) => [
  headerText(theme, model),
  ...(model.cache ? [cacheText(theme, model.cache)] : []),
  "",
  theme.bold("Estimated usage by category"),
  ...model.categories.map((category) => legendLine(theme, category, model.full)),
];

const bodyLines = (theme: ThemeLike, model: UsageModel, width: number) => {
  const side = sideLines(theme, model);
  const sideWidth = Math.max(...side.map((line) => theme.width(line)));
  const shape = gridLayout(model.window, width, sideWidth);
  const grid = gridRows(theme, gridCells(model, shape.columns * shape.rows), shape.columns);

  if (!shape.beside) {
    return [...grid.map((row) => `${PAD}${row}`), "", ...side.map((line) => (line ? `${PAD}${line}` : line))];
  }

  const blank = " ".repeat(shape.columns * 2 - 1);

  return Array.from({ length: Math.max(grid.length, side.length) }, (_, index) => {
    const right = side[index] ?? "";
    const left = grid[index];

    if (left === undefined) {
      return right ? `${PAD}${blank}${GAP}${right}` : "";
    }

    return right ? `${PAD}${left}${GAP}${right}` : `${PAD}${left}`;
  });
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const branch = (theme: ThemeLike, text: string) => `${PAD}${theme.fg("dim", "└")} ${text}`;

const title = (theme: ThemeLike, name: string, hint?: string) =>
  `${PAD}${theme.bold(name)}${hint ? theme.fg("dim", `${DOT}${hint}`) : ""}`;

const partLines = (theme: ThemeLike, parts: readonly ContextPart[], onDemand = false) =>
  byTokens(parts).map((part) =>
    branch(
      theme,
      onDemand && part.tokens === 0
        ? `${part.name}: ${theme.fg("dim", "loaded on demand")}`
        : `${part.name}: ${formatTokens(part.tokens)} tokens`,
    ),
  );

type Section = {
  name: string;
  hint?: string;
  parts: ContextPart[];
  one: string;
  many: string;
  onDemand?: boolean;
};

const summaryOf = (section: Section) => {
  const waiting = section.onDemand ? section.parts.filter((part) => part.tokens === 0).length : 0;

  return [
    plural(section.parts.length, section.one, section.many),
    `${formatTokens(sumParts(section.parts))} tokens`,
    ...(waiting > 0 ? [`${waiting} loaded on demand`] : []),
  ].join(DOT);
};

const sectionLines = (theme: ThemeLike, section: Section, expanded: boolean) => {
  if (section.parts.length === 0) {
    return [];
  }

  const body = expanded
    ? partLines(theme, section.parts, section.onDemand)
    : [branch(theme, summaryOf(section))];

  return [title(theme, section.name, section.hint), ...body];
};

const BUCKETS: { key: Exclude<keyof ContextBreakdown["messages"], "count">; label: string }[] = [
  { key: "toolResults", label: "tool results" },
  { key: "assistant", label: "assistant" },
  { key: "user", label: "user" },
  { key: "thinking", label: "thinking" },
  { key: "toolCalls", label: "tool calls" },
  { key: "other", label: "other" },
];

const messageLines = (theme: ThemeLike, messages: ContextBreakdown["messages"], expanded: boolean) => {
  if (messages.count === 0) {
    return [];
  }

  const buckets = BUCKETS.map(({ key, label }) => ({ label, tokens: messages[key] }))
    .filter((bucket) => bucket.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens);

  const body = expanded
    ? buckets.map((bucket) => branch(theme, `${bucket.label}: ${formatTokens(bucket.tokens)} tokens`))
    : [
        branch(
          theme,
          [
            plural(messages.count, "message", "messages"),
            ...buckets.map((bucket) => `${bucket.label} ${formatTokens(bucket.tokens)}`),
          ].join(DOT),
        ),
      ];

  return [title(theme, "Messages"), ...body];
};

const detailLines = (theme: ThemeLike, breakdown: ContextBreakdown, expanded: boolean) => [
  ...sectionLines(
    theme,
    { name: "Memory files", hint: "AGENTS.md", parts: breakdown.memoryFiles, one: "file", many: "files" },
    expanded,
  ),
  ...sectionLines(
    theme,
    { name: "Skills", hint: "/skill:<name>", parts: breakdown.skills, one: "skill", many: "skills" },
    expanded,
  ),
  ...sectionLines(
    theme,
    {
      name: "MCP tools",
      hint: "/mcp",
      parts: breakdown.tools.mcp,
      one: "tool",
      many: "tools",
      onDemand: true,
    },
    expanded,
  ),
  ...sectionLines(
    theme,
    { name: "Extension tools", parts: breakdown.tools.extension, one: "tool", many: "tools" },
    expanded,
  ),
  ...(expanded
    ? sectionLines(
        theme,
        { name: "System tools", parts: breakdown.tools.builtin, one: "tool", many: "tools" },
        expanded,
      )
    : []),
  ...messageLines(theme, breakdown.messages, expanded),
];

const twoDigits = (value: number) => `${value}`.padStart(2, "0");

const clockText = (timestamp: number) => {
  const date = new Date(timestamp);

  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
};

const hintLine = (theme: ThemeLike, snapshot: Snapshot, options: RenderOptions) => {
  if (snapshot.expandedByDefault) {
    return [];
  }

  return [`${PAD}${theme.fg("dim", `${options.expandKey} to ${options.expanded ? "collapse" : "expand"}`)}`];
};

export const renderSnapshot = (theme: ThemeLike, snapshot: Snapshot, options: RenderOptions): string[] => {
  const model = usageModel(snapshot);
  const expanded = options.expanded || snapshot.expandedByDefault;
  const details = detailLines(theme, snapshot.breakdown, expanded);
  const overflow =
    model.overflow > 0
      ? [
          `${PAD}${theme.fg("error", `Context exceeds the window by ${formatTokens(model.overflow)} tokens${DOT}/compact`)}`,
        ]
      : [];
  const stamp = snapshot.timestamp > 0 ? clockText(snapshot.timestamp) : undefined;

  return [
    title(theme, "Context Usage", stamp),
    ...bodyLines(theme, model, options.width),
    ...overflow,
    ...(details.length > 0 ? ["", ...details] : []),
    ...(details.length > 0 ? hintLine(theme, snapshot, options) : []),
  ].map((line) => theme.truncate(line, options.width));
};

const plainText: ThemeLike = {
  fg: (_token, text) => text,
  bold: (text) => text,
  width: (text) => text.length,
  truncate: (text) => text,
  wrap: (text) => [text],
};

export const summaryLine = (snapshot: Snapshot) => {
  const model = usageModel(snapshot);

  return [
    `Context: ${headerText(plainText, model)}`,
    ...(model.cache ? [cacheText(plainText, model.cache)] : []),
  ].join(DOT);
};
