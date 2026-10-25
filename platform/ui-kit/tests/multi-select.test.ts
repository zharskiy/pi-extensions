import { describe, expect, it } from "vitest";
import { char, key, plainTheme } from "../../../test/framework/index.ts";
import { type MultiState, moreRow, multiKey, multiLines, scrolledLines } from "../multi-select.ts";

const initial = (count: number, checked: readonly boolean[] = []): MultiState => ({
  cursor: 0,
  checked: Array.from({ length: count }, (_, index) => checked[index] === true),
});

const ticked = (state: MultiState) => state.checked.flatMap((value, index) => (value ? [index] : []));

describe("multiKey", () => {
  it("keeps the pointer inside the list and leaves Enter, Escape and other keys to the caller", () => {
    const state = initial(3);

    expect(multiKey(key("up"), state)?.cursor).toBe(0);
    expect(multiKey(key("end"), state)?.cursor).toBe(2);
    expect(multiKey(key("down"), { ...state, cursor: 2 })?.cursor).toBe(2);
    expect(multiKey(key("enter"), state)).toBeUndefined();
    expect(multiKey(key("escape"), state)).toBeUndefined();
    expect(multiKey(char("x"), state)).toBeUndefined();
  });

  it("toggles the row under the pointer with Space and checks every row with a and none with n", () => {
    const state = initial(3, [false, true]);
    const toggled = multiKey(key("space"), { ...state, cursor: 2 }) ?? state;

    expect(ticked(toggled)).toEqual([1, 2]);
    expect(ticked(multiKey(char("a"), state) ?? state)).toEqual([0, 1, 2]);
    expect(ticked(multiKey(char("n"), toggled) ?? toggled)).toEqual([]);
  });

  it("does nothing harmful on an empty list", () => {
    const state = initial(0);

    expect(multiKey(key("space"), state)).toEqual(state);
    expect(multiKey(key("down"), state)).toEqual(state);
    expect(ticked(multiKey(char("a"), state) ?? state)).toEqual([]);
  });
});

describe("multiLines", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ label: `skill-${index + 1}` }));

  it("shows a scroll window around the pointer with counts of the rows above and below", () => {
    const lines = multiLines(plainTheme, many, { ...initial(12), cursor: 6 }, 40, 4);

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

    expect(multiLines(plainTheme, options, initial(2, [false, true]), 40)).toEqual([
      " › [ ] alpha  first",
      "   [x] beta",
    ]);
  });

  it("cuts a description wider than the row to one line with an ellipsis", () => {
    const options = [
      { label: "review", description: "Reviews diffs for correctness, style and missing tests" },
      { label: "plan", description: "short" },
    ];
    const lines = multiLines(plainTheme, options, initial(2), 30);

    expect(lines).toEqual([" › [ ] review  Reviews diff...", "   [ ] plan  short"]);
  });

  it("still wraps a name that alone is wider than the row", () => {
    const options = [{ label: "a-very-long-skill-name-indeed", description: "never shown" }];

    expect(multiLines(plainTheme, options, initial(1), 20)).toEqual([
      " › [ ] a-very-long-s",
      "       kill-name-ind",
      "       eed",
    ]);
  });

  it("says when there is nothing to choose", () => {
    expect(multiLines(plainTheme, [], initial(0), 40)).toEqual([" (none available)"]);
  });
});

describe("multiLines with slots", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ label: `skill-${index + 1}` }));
  const slotted = (cursor: number) =>
    multiLines(plainTheme, many, { ...initial(12), cursor }, 40, 4, { slots: true });

  it("always keeps a row for each scroll count, blank when nothing is hidden there", () => {
    expect(slotted(0)).toEqual([
      "",
      " › [ ] skill-1",
      "   [ ] skill-2",
      "   [ ] skill-3",
      "   [ ] skill-4",
      " ↓ 8 more",
    ]);
    expect(slotted(6)).toEqual([
      " ↑ 4 more",
      "   [ ] skill-5",
      "   [ ] skill-6",
      " › [ ] skill-7",
      "   [ ] skill-8",
      " ↓ 4 more",
    ]);
    expect(slotted(11)).toEqual([
      " ↑ 8 more",
      "   [ ] skill-9",
      "   [ ] skill-10",
      "   [ ] skill-11",
      " › [ ] skill-12",
      "",
    ]);
  });

  it("pads a short list to the height and cuts a long name to one row", () => {
    const options = [{ label: "a-very-long-skill-name-indeed", description: "never shown" }];

    expect(multiLines(plainTheme, options, initial(1), 20, 3, { slots: true })).toEqual([
      "",
      " › [ ] a-very-lon...",
      "",
      "",
      "",
    ]);
  });

  it("puts none available in the first option row", () => {
    expect(multiLines(plainTheme, [], initial(0), 40, 2, { slots: true })).toEqual([
      "",
      " (none available)",
      "",
      "",
    ]);
  });
});

describe("scrolledLines with slots", () => {
  it("keeps the height when the rows fit without scrolling", () => {
    const row = (index: number) => [`row ${index}`];

    expect(scrolledLines(plainTheme, 2, 0, 3, 40, row, { slots: true })).toEqual([
      "",
      "row 0",
      "row 1",
      "",
      "",
    ]);
    expect(scrolledLines(plainTheme, 2, 0, 3, 40, row)).toEqual(["row 0", "row 1"]);
  });
});

describe("scroll window", () => {
  const rows = (cursor: number, count = 12) =>
    scrolledLines(plainTheme, count, cursor, 4, 40, (index) => [`row ${index}`], { slots: true });

  it("starts at the top, centres the pointer in the middle and stops at the bottom", () => {
    expect(rows(0).slice(1, 5)).toEqual(["row 0", "row 1", "row 2", "row 3"]);
    expect(rows(6).slice(1, 5)).toEqual(["row 4", "row 5", "row 6", "row 7"]);
    expect(rows(11).slice(1, 5)).toEqual(["row 8", "row 9", "row 10", "row 11"]);
    expect(rows(1, 2).slice(1, 3)).toEqual(["row 0", "row 1"]);
  });

  it("puts the given empty text in the first option row", () => {
    expect(rows(0, 0)).toEqual(["", " (none available)", "", "", "", ""]);
    expect(
      scrolledLines(plainTheme, 0, 0, 2, 40, () => [], { slots: true, empty: 'no skill matches "z"' }),
    ).toEqual(["", ' no skill matches "z"', "", ""]);
  });
});

describe("moreRow", () => {
  it("counts the hidden rows after the prefix and is blank when nothing is hidden", () => {
    expect(moreRow(plainTheme, "↑", 3, 40)).toBe(" ↑ 3 more");
    expect(moreRow(plainTheme, "↓", 12, 40, "   ")).toBe("   ↓ 12 more");
    expect(moreRow(plainTheme, "↓", 0, 40)).toBe("");
    expect(moreRow(plainTheme, "↓", 123, 8)).toBe(" ↓ 12...");
  });
});
