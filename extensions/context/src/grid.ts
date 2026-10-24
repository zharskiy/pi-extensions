import type { ThemeLike, ThemeToken } from "../../../core/adapter/contract.ts";
import { apportion, type CategoryKey, type UsageModel } from "./breakdown.ts";

type Grid = { rows: string[]; columns: number; beside: boolean };

export const GAP = "   ";

const NARROW_MAX = 50;

const WIDE_WINDOW = 1_000_000;

const COLORS: Record<CategoryKey, ThemeToken> = {
  systemPrompt: "thinkingOff",
  systemTools: "thinkingMinimal",
  mcpTools: "thinkingLow",
  extensionTools: "thinkingMedium",
  memoryFiles: "thinkingHigh",
  skills: "thinkingXhigh",
  messages: "text",
  free: "muted",
  reserve: "warning",
};

const CELLS: Partial<Record<CategoryKey, string>> = { free: "·", reserve: "░" };

const USED = "■";

export const legendGlyph = (theme: ThemeLike, key: CategoryKey) => theme.fg(COLORS[key], CELLS[key] ?? USED);

const besideWidth = (columns: number, side: number) => columns * 2 - 1 + GAP.length + side;

const gridLayout = (window: number, width: number, room: number, side: number) => {
  if (width < NARROW_MAX) {
    return { columns: 5, rows: 5, beside: false };
  }

  if (window >= WIDE_WINDOW && besideWidth(20, side) <= room) {
    return { columns: 20, rows: 10, beside: true };
  }

  return { columns: 10, rows: 10, beside: besideWidth(10, side) <= room };
};

const sameCells = (count: number, key: CategoryKey): CategoryKey[] =>
  Array.from({ length: count }, () => key);

const gridCells = (model: UsageModel, count: number): CategoryKey[] => {
  const cellTokens = model.window / count;

  if (cellTokens <= 0) {
    return sameCells(count, "free");
  }

  const reserveTokens = model.categories.find((category) => category.key === "reserve")?.tokens ?? 0;
  const reserveCells = Math.min(count, Math.round(reserveTokens / cellTokens));
  const room = count - reserveCells;

  const categories = model.categories.filter(
    (category) => category.key !== "free" && category.key !== "reserve",
  );

  const exact = categories.map((category) => category.tokens / cellTokens);
  const filled = Math.min(room, Math.round(exact.reduce((sum, cells) => sum + cells, 0)));
  const shares = apportion(exact, filled);
  const used = categories.flatMap((category, index) => sameCells(shares[index] ?? 0, category.key));

  return [...used, ...sameCells(room - used.length, "free"), ...sameCells(reserveCells, "reserve")];
};

export const gridOf = (
  theme: ThemeLike,
  model: UsageModel,
  width: number,
  room: number,
  side: number,
): Grid => {
  const layout = gridLayout(model.window, width, room, side);
  const cells = gridCells(model, layout.columns * layout.rows);

  const rows = Array.from({ length: layout.rows }, (_, row) =>
    cells
      .slice(row * layout.columns, (row + 1) * layout.columns)
      .map((key) => legendGlyph(theme, key))
      .join(" "),
  );

  return { rows, columns: layout.columns, beside: layout.beside };
};
