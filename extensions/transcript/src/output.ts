import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { noun } from "../../../core/manager/row.ts";

export type Truncated = { lines: string[]; hidden: number };

export const PREVIEW_LINES = 3;

export const truncatedOutput = (
  text: string,
  max = PREVIEW_LINES,
  keep: "head" | "tail" = "head",
): Truncated => {
  const lines = text.replace(/\s+$/, "").split("\n");
  const all = lines.length === 1 && lines[0] === "" ? [] : lines;
  const shown = keep === "head" ? all.slice(0, max) : all.slice(Math.max(0, all.length - max));

  return { lines: shown, hidden: all.length - shown.length };
};

export const moreLine = (hidden: number, theme: ThemeLike) =>
  theme.fg("dim", `… +${hidden} ${noun(hidden, "line")}`);
