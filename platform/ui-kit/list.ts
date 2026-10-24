import { type KeyPress, PAD, type ThemeLike } from "../pi-adapter/index.ts";
import { prefixed } from "../shared/index.ts";
import { pointerMark } from "./glyphs.ts";
import type { KeyHint } from "./key-hints.ts";

const DESCRIPTION_INDENT = "      ";

export const SELECT_HINTS: readonly KeyHint[] = [
  ["↑↓", "to select"],
  ["1-9", "to pick"],
];

export const CANCEL_HINT: KeyHint = ["esc", "to cancel"];

export type ListOption = {
  label: string;
  description?: string;
  mark?: string;
  active?: boolean;
};

export type ListLayout = "beside" | "below";

export const listLines = (
  theme: ThemeLike,
  options: readonly ListOption[],
  selected: number,
  width: number,
  { layout = "below" }: { layout?: ListLayout } = {},
) =>
  options.flatMap((option, index) => {
    const chosen = index === selected;
    const pointer = pointerMark(theme, chosen);
    const mark = option.mark ? ` ${option.mark}` : "";

    const label = theme.fg(
      chosen || option.active ? "accent" : "text",
      `${index + 1}. ${option.label}${mark}`,
    );

    const beside =
      layout === "beside" && option.description ? `  ${theme.fg("muted", option.description)}` : "";

    const below =
      layout === "below" && option.description
        ? prefixed(theme, DESCRIPTION_INDENT, theme.fg("muted", option.description), width)
        : [];

    return [...prefixed(theme, `${PAD}${pointer} `, `${label}${beside}`, width), ...below];
  });

const digitOf = (key: KeyPress) =>
  key.name === "other" && key.char && /^[1-9]$/.test(key.char) ? Number(key.char) : undefined;

export const clampIndex = (index: number, count: number) => Math.max(0, Math.min(count - 1, index));

export const listKey = (key: KeyPress, index: number, count: number) => {
  const digit = digitOf(key);

  if (digit !== undefined) {
    return digit <= count ? { index: digit - 1, pick: true } : undefined;
  }

  if (key.name === "enter") {
    return { index, pick: true };
  }

  const moves: Partial<Record<KeyPress["name"], number>> = {
    up: index - 1,
    down: index + 1,
    home: 0,
    end: count - 1,
  };
  const target = moves[key.name];

  return target === undefined ? undefined : { index: clampIndex(target, count), pick: false };
};
