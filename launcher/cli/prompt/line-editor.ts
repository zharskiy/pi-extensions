import type { Key } from "./types.ts";

export interface LineState {
  value: string;
  cursor: number;
}

export interface EditOptions {
  segments?: boolean;
}

export const lineOf = (value: string): LineState => ({ value, cursor: Array.from(value).length });

const joined = (left: string[], right: string[]): LineState => ({
  value: [...left, ...right].join(""),
  cursor: left.length,
});

const wordStart = (before: string[], segments: boolean) => {
  const boundary = segments ? "/" : " ";
  const end = before.findLastIndex((char) => char !== boundary) + 1;

  return before.slice(0, end).lastIndexOf(boundary) + 1;
};

const ctrlEdit = (state: LineState, letter: string, before: string[], after: string[]): LineState => {
  switch (letter) {
    case "a":
      return { ...state, cursor: 0 };
    case "e":
      return { ...state, cursor: before.length + after.length };
    case "u":
      return joined([], after);
    case "k":
      return joined(before, []);
    case "d":
      return joined(before, after.slice(1));
    default:
      return state;
  }
};

export const editLine = (state: LineState, key: Key, options: EditOptions = {}): LineState => {
  const chars = Array.from(state.value);
  const before = chars.slice(0, state.cursor);
  const after = chars.slice(state.cursor);

  switch (key.kind) {
    case "text":
    case "paste":
      return joined([...before, ...Array.from(key.text)], after);
    case "space":
      return joined([...before, " "], after);
    case "left":
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case "right":
      return { ...state, cursor: Math.min(chars.length, state.cursor + 1) };
    case "home":
      return { ...state, cursor: 0 };
    case "end":
      return { ...state, cursor: chars.length };
    case "backspace":
      return joined(before.slice(0, -1), after);
    case "delete":
      return joined(before, after.slice(1));
    case "word-left-delete":
      return joined(before.slice(0, wordStart(before, options.segments === true)), after);
    case "ctrl":
      return ctrlEdit(state, key.letter, before, after);
    default:
      return state;
  }
};
