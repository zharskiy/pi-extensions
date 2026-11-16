import { type FormFactory, type KeyPress, PAD, type ThemeLike } from "../pi-adapter/index.ts";
import { padded, padRows, prefixed } from "../shared/index.ts";
import { pointerMark } from "./glyphs.ts";
import { type KeyHint, titledFrame } from "./key-hints.ts";
import { CANCEL_HINT, cursorKey, MOVE_HINT } from "./list.ts";

export type MultiOption = { label: string; description?: string };

export type MultiState = { cursor: number; checked: readonly boolean[] };

const MULTI_SELECT_HINTS: readonly KeyHint[] = [
  MOVE_HINT,
  ["space", "to toggle"],
  ["a", "to check all"],
  ["n", "to check none"],
];

const DEFAULT_HEIGHT = 10;

const initialMulti = (count: number, checked: readonly boolean[] = []): MultiState => ({
  cursor: 0,
  checked: Array.from({ length: count }, (_, index) => checked[index] === true),
});

const scrollWindow = (count: number, cursor: number, height: number) => {
  const size = Math.max(1, height);
  const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), count - size));

  return { start, end: Math.min(count, start + size) };
};

type ListLayout = { slots?: boolean; empty?: string };

const NONE_AVAILABLE = "(none available)";

export const moreRow = (theme: ThemeLike, arrow: "↑" | "↓", hidden: number, width: number) =>
  hidden > 0
    ? `${PAD}${theme.fg("dim", theme.truncate(`${arrow} ${hidden} more`, Math.max(1, width - theme.width(PAD))))}`
    : "";

const emptyRow = (theme: ThemeLike, text: string, width: number) =>
  `${PAD}${theme.fg("muted", theme.truncate(text, Math.max(1, width - PAD.length)))}`;

export const scrolledLines = (
  theme: ThemeLike,
  count: number,
  cursor: number,
  height: number,
  width: number,
  row: (index: number, chosen: boolean) => string[],
  { slots = false, empty = NONE_AVAILABLE }: ListLayout = {},
) => {
  const { start, end } = scrollWindow(count, cursor, height);
  const rows = Array.from({ length: end - start }, (_, offset) => start + offset).flatMap((index) =>
    row(index, index === cursor),
  );

  if (slots) {
    const shown = count === 0 ? [emptyRow(theme, empty, width)] : rows;

    return [
      moreRow(theme, "↑", start, width),
      ...padRows(shown, Math.max(1, height)),
      moreRow(theme, "↓", count - end, width),
    ];
  }

  const edge = (arrow: "↑" | "↓", hidden: number) =>
    hidden > 0 ? [moreRow(theme, arrow, hidden, width)] : [];

  return [...edge("↑", start), ...rows, ...edge("↓", count - end)];
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
  const cursor = cursorKey(key, state.cursor, count);

  if (cursor !== undefined) {
    return count === 0 ? state : { ...state, cursor };
  }

  if (key.name === "space") {
    return count === 0 ? state : toggle(state);
  }

  if (key.name === "other" && (key.shortcut === "a" || key.shortcut === "n")) {
    return fill(state, key.shortcut === "a");
  }

  return undefined;
};

const ROW_MARKS = "› [ ] ";

const descriptionRoom = (theme: ThemeLike, label: string, width: number) =>
  width - theme.width(`${PAD}${ROW_MARKS}`) - theme.width(label) - 2;

export const multiLines = (
  theme: ThemeLike,
  options: readonly MultiOption[],
  state: MultiState,
  width: number,
  height = DEFAULT_HEIGHT,
  layout: ListLayout = {},
) => {
  if (options.length === 0 && !layout.slots) {
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

    return layout.slots
      ? [`${first}${theme.truncate(`${label}${description}`, Math.max(1, width - theme.width(first)))}`]
      : prefixed(theme, first, `${label}${description}`, width);
  };

  return scrolledLines(theme, options.length, state.cursor, height, width, row, layout);
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
        titledFrame(api.theme, width, spec.title, multiLines(api.theme, spec.options, state, width), hints),
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
