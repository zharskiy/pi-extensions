import type { ThemeLike, ThemeToken } from "../types/theme.ts";

const RULE_FRAME = 6;

export const rule = (theme: ThemeLike, width: number) => theme.fg("accent", "─".repeat(Math.max(1, width)));

export const labelledRule = (theme: ThemeLike, width: number, label: string, token: ThemeToken = "dim") => {
  if (width < RULE_FRAME) {
    return theme.fg(token, "─".repeat(Math.max(1, width)));
  }

  const shown = theme.width(label) + RULE_FRAME > width ? theme.truncate(label, width - RULE_FRAME) : label;
  const fill = "─".repeat(width - theme.width(shown) - 4);

  return theme.fg(token, `── ${shown} ${fill}`);
};
