import { CHILD_MARK, type ThemeLike, type ThemeToken } from "../pi-adapter/index.ts";

export const MARKS = {
  pending: "◌",
  success: "✓",
  error: "✗",
  stopped: "⊘",
  info: "»",
  child: CHILD_MARK,
  pointer: "›",
} as const;

export type Mark = "pending" | "success" | "error" | "stopped" | "info";

const MARK_TOKENS: Record<Mark, ThemeToken> = {
  pending: "dim",
  success: "success",
  error: "error",
  stopped: "muted",
  info: "accent",
};

export const pointerMark = (theme: ThemeLike, chosen: boolean) =>
  chosen ? theme.fg("accent", theme.bold(MARKS.pointer)) : " ";

export const markGlyph = (mark: Mark, theme: ThemeLike) => theme.fg(MARK_TOKENS[mark], MARKS[mark]);

export const markOf = (view: {
  started?: boolean;
  isPartial: boolean;
  isError: boolean;
  aborted?: boolean;
}): Mark => {
  if (view.started === false || view.isPartial) {
    return "pending";
  }

  if (view.aborted) {
    return "stopped";
  }

  return view.isError ? "error" : "success";
};
