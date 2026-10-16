import type { ThemeLike, ThemeToken } from "../../../core/adapter/contract.ts";
import { PAD } from "../../../core/manager/layout.ts";
import { apportion, type CategoryKey, type UsageModel } from "./breakdown.ts";

type Cell = { key: CategoryKey; partial: boolean };

type Grid = { rows: string[]; columns: number; beside: boolean };

export const GAP = "   ";

const NARROW_MAX = 50;

const WIDE_WINDOW = 1_000_000;

const COLORS: Record<CategoryKey, ThemeToken> = {
  systemPrompt: "comment",
  systemTools: "type",
  mcpTools: "function",
  extensionTools: "keyword",
  memoryFiles: "string",
  skills: "number",
  messages: "accent",
  free: "dim",
  reserve: "warning",
};

const GLYPHS: Partial<Record<CategoryKey, string>> = { free: "⛶", reserve: "⛝" };

const USED = "⛁";

const PARTIAL = "⛀";

const glyphOf = (cell: Cell) => GLYPHS[cell.key] ?? (cell.partial ? PARTIAL : USED);

const paintCell = (theme: ThemeLike, cell: Cell) => theme.fg(COLORS[cell.key], glyphOf(cell));

export const legendGlyph = (theme: ThemeLike, key: CategoryKey) => paintCell(theme, { key, partial: false });

const besideWidth = (columns: number, side: number) => PAD.length + columns * 2 - 1 + GAP.length + side;

const gridLayout = (window: number, width: number, side: number) => {
  if (width < NARROW_MAX) {
    return { columns: 5, rows: 5, beside: false };
  }

  if (window >= WIDE_WINDOW && besideWidth(20, side) <= width) {
    return { columns: 20, rows: 10, beside: true };
  }

  return { columns: 10, rows: 10, beside: besideWidth(10, side) <= width };
};

const sameCells = (count: number, key: CategoryKey): Cell[] =>
  Array.from({ length: count }, () => ({ key, partial: false }));

const gridCells = (model: UsageModel, count: number): Cell[] => {
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

  const used = categories.flatMap((category, index) => {
    const share = shares[index] ?? 0;
    const partial = share > (exact[index] ?? 0);

    return Array.from({ length: share }, (_, cell) => ({
      key: category.key,
      partial: partial && cell === share - 1,
    }));
  });

  return [...used, ...sameCells(room - used.length, "free"), ...sameCells(reserveCells, "reserve")];
};

export const gridOf = (theme: ThemeLike, model: UsageModel, width: number, side: number): Grid => {
  const layout = gridLayout(model.window, width, side);
  const cells = gridCells(model, layout.columns * layout.rows);

  const rows = Array.from({ length: layout.rows }, (_, row) =>
    cells
      .slice(row * layout.columns, (row + 1) * layout.columns)
      .map((cell) => paintCell(theme, cell))
      .join(" "),
  );

  return { rows, columns: layout.columns, beside: layout.beside };
};
