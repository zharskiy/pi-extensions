import { type KeyPress, PAD, type ThemeLike } from "../pi-adapter/index.ts";
import { prefixed } from "../shared/index.ts";
import { pointerMark } from "./glyphs.ts";
import type { KeyHint } from "./key-hints.ts";

const DESCRIPTION_INDENT = "      ";

export const MOVE_HINT: KeyHint = ["↑↓", "to select"];

export const SELECT_HINTS: readonly KeyHint[] = [MOVE_HINT, ["1-9", "to pick"]];

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
  { layout = "below", cut = false }: { layout?: ListLayout; cut?: boolean } = {},
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

    if (cut) {
      return [theme.truncate(`${PAD}${pointer} ${label}${beside}`, width)];
    }

    return [...prefixed(theme, `${PAD}${pointer} `, `${label}${beside}`, width), ...below];
  });

const digitOf = (key: KeyPress) =>
  key.name === "other" && key.char && /^[1-9]$/.test(key.char) ? Number(key.char) : undefined;

export const clampIndex = (index: number, count: number) => Math.max(0, Math.min(count - 1, index));

const MOVES: Partial<Record<KeyPress["name"], (index: number, count: number) => number>> = {
  up: (index) => index - 1,
  down: (index) => index + 1,
  home: () => 0,
  end: (_, count) => count - 1,
};

export const cursorKey = (key: KeyPress, index: number, count: number) => {
  const move = MOVES[key.name];

  return move ? clampIndex(move(index, count), count) : undefined;
};

export const listKey = (key: KeyPress, index: number, count: number) => {
  const digit = digitOf(key);

  if (digit !== undefined) {
    return digit <= count ? { index: digit - 1, pick: true } : undefined;
  }

  if (key.name === "enter") {
    return { index, pick: true };
  }

  const target = cursorKey(key, index, count);

  return target === undefined ? undefined : { index: target, pick: false };
};
