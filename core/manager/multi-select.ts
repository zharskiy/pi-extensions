import type { KeyPress, ThemeLike } from "../adapter/contract.ts";
import { PAD, padded, prefixed } from "./layout.ts";
import { clampIndex } from "./list.ts";

type MultiOption = { label: string; description?: string };

export type MultiState = { cursor: number; checked: readonly boolean[] };

export const MULTI_SELECT_HINTS = ["↑↓ select", "Space toggle", "a all", "n none"] as const;

const DEFAULT_HEIGHT = 10;

export const initialMulti = (count: number, checked: readonly boolean[] = []): MultiState => ({
  cursor: 0,
  checked: Array.from({ length: count }, (_, index) => checked[index] === true),
});

export const scrollWindow = (count: number, cursor: number, height: number) => {
  const size = Math.max(1, height);
  const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), count - size));

  return { start, end: Math.min(count, start + size) };
};

const MOVES: Partial<Record<KeyPress["name"], (state: MultiState, count: number) => number>> = {
  up: (state) => state.cursor - 1,
  down: (state) => state.cursor + 1,
  home: () => 0,
  end: (_, count) => count - 1,
};

const fill = (state: MultiState, value: boolean): MultiState => ({
  ...state,
  checked: state.checked.map(() => value),
});

const toggle = (state: MultiState): MultiState => ({
  ...state,
  checked: state.checked.map((value, index) => (index === state.cursor ? !value : value)),
});

export const multiKey = (key: KeyPress, state: MultiState): MultiState | undefined => {
  const count = state.checked.length;
  const move = MOVES[key.name];

  if (move) {
    return count === 0 ? state : { ...state, cursor: clampIndex(move(state, count), count) };
  }

  if (key.name === "space") {
    return count === 0 ? state : toggle(state);
  }

  if (key.name === "other" && (key.char === "a" || key.char === "n")) {
    return fill(state, key.char === "a");
  }

  return undefined;
};

export const checkedIndexes = (state: MultiState) =>
  state.checked.flatMap((value, index) => (value ? [index] : []));

export const multiLines = (
  theme: ThemeLike,
  options: readonly MultiOption[],
  state: MultiState,
  width: number,
  height = DEFAULT_HEIGHT,
) => {
  if (options.length === 0) {
    return padded(theme, theme.fg("muted", "(none available)"), width);
  }

  const { start, end } = scrollWindow(options.length, state.cursor, height);

  const rows = options.slice(start, end).flatMap((option, offset) => {
    const index = start + offset;
    const chosen = index === state.cursor;
    const pointer = chosen ? theme.fg("accent", theme.bold("›")) : " ";
    const box = state.checked[index] ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
    const label = theme.fg(chosen ? "accent" : "text", option.label);
    const description = option.description ? `  ${theme.fg("muted", option.description)}` : "";

    return prefixed(theme, `${PAD}${pointer} ${box} `, `${label}${description}`, width);
  });

  const more = (text: string) => padded(theme, theme.fg("dim", text), width);
  const above = start > 0 ? more(`↑ ${start} more`) : [];
  const below = end < options.length ? more(`↓ ${options.length - end} more`) : [];

  return [...above, ...rows, ...below];
};
