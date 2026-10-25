import { type FormFactory, type KeyPress, PAD, type ThemeLike } from "../pi-adapter/index.ts";
import { padded, padRows, prefixed } from "../shared/index.ts";
import { pointerMark } from "./glyphs.ts";
import { framed, type KeyHint } from "./key-hints.ts";
import { CANCEL_HINT, clampIndex } from "./list.ts";

export type MultiOption = { label: string; description?: string };

export type MultiState = { cursor: number; checked: readonly boolean[] };

const MULTI_SELECT_HINTS: readonly KeyHint[] = [
  ["↑↓", "to select"],
  ["space", "to toggle"],
  ["a", "to check all"],
  ["n", "to check none"],
];

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

type ListLayout = { slots?: boolean };

const slotLine = (theme: ThemeLike, text: string, width: number) =>
  `${PAD}${theme.fg("dim", theme.truncate(text, Math.max(1, width - PAD.length)))}`;

export const scrolledLines = (
  theme: ThemeLike,
  count: number,
  cursor: number,
  height: number,
  width: number,
  row: (index: number, chosen: boolean) => string[],
  { slots = false }: ListLayout = {},
) => {
  const { start, end } = scrollWindow(count, cursor, height);
  const rows = Array.from({ length: end - start }, (_, offset) => start + offset).flatMap((index) =>
    row(index, index === cursor),
  );
  const up = `↑ ${start} more`;
  const down = `↓ ${count - end} more`;

  if (slots) {
    const above = start > 0 ? slotLine(theme, up, width) : "";
    const below = end < count ? slotLine(theme, down, width) : "";

    return [above, ...padRows(rows, Math.max(1, height)), below];
  }

  const more = (text: string) => padded(theme, theme.fg("dim", text), width);
  const above = start > 0 ? more(up) : [];
  const below = end < count ? more(down) : [];

  return [...above, ...rows, ...below];
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

const ROW_MARKS = "› [ ] ";

const descriptionRoom = (theme: ThemeLike, label: string, width: number) =>
  width - theme.width(`${PAD}${ROW_MARKS}`) - theme.width(label) - 2;

const NONE_AVAILABLE = "(none available)";

export const multiLines = (
  theme: ThemeLike,
  options: readonly MultiOption[],
  state: MultiState,
  width: number,
  height = DEFAULT_HEIGHT,
  { slots = false }: ListLayout = {},
) => {
  if (options.length === 0 && slots) {
    const none = `${PAD}${theme.fg("muted", theme.truncate(NONE_AVAILABLE, Math.max(1, width - PAD.length)))}`;

    return padRows(["", none], Math.max(1, height) + 2);
  }

  if (options.length === 0) {
    return padded(theme, theme.fg("muted", NONE_AVAILABLE), width);
  }

  const row = (index: number, chosen: boolean) => {
    const option = options[index];
    const box = state.checked[index] ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
    const first = `${PAD}${pointerMark(theme, chosen)} ${box} `;
    const name = option?.label ?? "";
    const label = theme.fg(chosen ? "accent" : "text", name);
    const room = descriptionRoom(theme, name, width);
    const description =
      option?.description && room > 0
        ? `  ${theme.fg("muted", theme.truncate(option.description, room))}`
        : "";

    return slots
      ? [`${first}${theme.truncate(`${label}${description}`, Math.max(1, width - theme.width(first)))}`]
      : prefixed(theme, first, `${label}${description}`, width);
  };

  return scrolledLines(theme, options.length, state.cursor, height, width, row, { slots });
};

export type MultiSelectSpec<T> = {
  title: string;
  options: readonly (MultiOption & { value: T })[];
  checked?: readonly boolean[];
  submitHint?: string;
};

export const multiSelectForm =
  <T>(spec: MultiSelectSpec<T>): FormFactory<T[] | undefined> =>
  (api) => {
    const hints: readonly KeyHint[] = [
      ...MULTI_SELECT_HINTS,
      ["enter", `to ${spec.submitHint ?? "confirm"}`],
      CANCEL_HINT,
    ];
    let state = initialMulti(spec.options.length, spec.checked);

    return {
      render: (width) =>
        framed(
          api.theme,
          width,
          [
            ...padded(api.theme, api.theme.fg("text", spec.title), width),
            "",
            ...multiLines(api.theme, spec.options, state, width),
          ],
          hints,
        ),
      handleKey: (key) => {
        if (key.name === "escape") {
          api.done(undefined);
          return;
        }

        if (key.name === "enter") {
          api.done(spec.options.filter((_, index) => state.checked[index]).map((option) => option.value));
          return;
        }

        const next = multiKey(key, state);

        if (!next) {
          return;
        }

        state = next;
        api.requestRender();
      },
    };
  };
