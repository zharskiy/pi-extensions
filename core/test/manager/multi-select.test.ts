import { describe, expect, it } from "vitest";
import type { KeyPress } from "../../adapter/contract.ts";
import {
  checkedIndexes,
  initialMulti,
  multiKey,
  multiLines,
  scrollWindow,
} from "../../manager/multi-select.ts";
import { plainTheme } from "../helpers/fakes.ts";

const key = (name: KeyPress["name"]): KeyPress => ({ name });

const char = (value: string): KeyPress => ({ name: "other", char: value, raw: value });

describe("multiKey", () => {
  it("keeps the pointer inside the list and leaves Enter, Escape and other keys to the caller", () => {
    const state = initialMulti(3);

    expect(multiKey(key("up"), state)?.cursor).toBe(0);
    expect(multiKey(key("end"), state)?.cursor).toBe(2);
    expect(multiKey(key("down"), { ...state, cursor: 2 })?.cursor).toBe(2);
    expect(multiKey(key("enter"), state)).toBeUndefined();
    expect(multiKey(key("escape"), state)).toBeUndefined();
    expect(multiKey(char("x"), state)).toBeUndefined();
  });

  it("toggles the row under the pointer with Space and checks every row with a and none with n", () => {
    const state = initialMulti(3, [false, true]);
    const toggled = multiKey(key("space"), { ...state, cursor: 2 }) ?? state;

    expect(checkedIndexes(toggled)).toEqual([1, 2]);
    expect(checkedIndexes(multiKey(char("a"), state) ?? state)).toEqual([0, 1, 2]);
    expect(checkedIndexes(multiKey(char("n"), toggled) ?? toggled)).toEqual([]);
  });

  it("does nothing harmful on an empty list", () => {
    const state = initialMulti(0);

    expect(multiKey(key("space"), state)).toEqual(state);
    expect(multiKey(key("down"), state)).toEqual(state);
    expect(checkedIndexes(multiKey(char("a"), state) ?? state)).toEqual([]);
  });
});

describe("multiLines", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ label: `skill-${index + 1}` }));

  it("shows a scroll window around the pointer with counts of the rows above and below", () => {
    const lines = multiLines(plainTheme, many, { ...initialMulti(12), cursor: 6 }, 40, 4);

    expect(lines).toEqual([
      " ↑ 4 more",
      "   [ ] skill-5",
      "   [ ] skill-6",
      " › [ ] skill-7",
      "   [ ] skill-8",
      " ↓ 4 more",
    ]);
  });

  it("marks checked rows and shows descriptions beside the label", () => {
    const options = [{ label: "alpha", description: "first" }, { label: "beta" }];

    expect(multiLines(plainTheme, options, initialMulti(2, [false, true]), 40)).toEqual([
      " › [ ] alpha  first",
      "   [x] beta",
    ]);
  });

  it("cuts a description wider than the row to one line with an ellipsis", () => {
    const options = [
      { label: "review", description: "Reviews diffs for correctness, style and missing tests" },
      { label: "plan", description: "short" },
    ];
    const lines = multiLines(plainTheme, options, initialMulti(2), 30);

    expect(lines).toEqual([" › [ ] review  Reviews diffs …", "   [ ] plan  short"]);
  });

  it("still wraps a name that alone is wider than the row", () => {
    const options = [{ label: "a-very-long-skill-name-indeed", description: "never shown" }];

    expect(multiLines(plainTheme, options, initialMulti(1), 20)).toEqual([
      " › [ ] a-very-long-s",
      "       kill-name-ind",
      "       eed",
    ]);
  });

  it("says when there is nothing to choose", () => {
    expect(multiLines(plainTheme, [], initialMulti(0), 40)).toEqual([" (none available)"]);
  });
});

describe("scrollWindow", () => {
  it("starts at the top, centres the pointer in the middle and stops at the bottom", () => {
    expect(scrollWindow(12, 0, 4)).toEqual({ start: 0, end: 4 });
    expect(scrollWindow(12, 6, 4)).toEqual({ start: 4, end: 8 });
    expect(scrollWindow(12, 11, 4)).toEqual({ start: 8, end: 12 });
    expect(scrollWindow(2, 1, 4)).toEqual({ start: 0, end: 2 });
  });
});
