import type { ThemeLike } from "../adapter/contract.ts";

export const PAD = " ";

export const DOT = " · ";

export const rule = (theme: ThemeLike, width: number) => theme.fg("accent", "─".repeat(Math.max(1, width)));

export const prefixed = (theme: ThemeLike, first: string, text: string, width: number) => {
  const indent = " ".repeat(theme.width(first));

  return theme
    .wrap(text, Math.max(1, width - theme.width(first)))
    .map((line, index) => `${index === 0 ? first : indent}${line}`);
};

export const padded = (theme: ThemeLike, text: string, width: number) => prefixed(theme, PAD, text, width);

export const hintLines = (theme: ThemeLike, hints: readonly string[], width: number) =>
  padded(theme, theme.fg("dim", hints.join(DOT)), width);
