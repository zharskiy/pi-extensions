import { describe, expect, it } from "vitest";
import type { KeyPress } from "../../adapter/contract.ts";
import {
  checkedIndexes,
  initialMulti,
  multiKey,
  multiLines,
  multiSelectForm,
  scrollWindow,
} from "../../manager/multi-select.ts";
import { plainTheme } from "../helpers/fakes.ts";

const key = (name: KeyPress["name"]): KeyPress => ({ name });

const char = (value: string): KeyPress => ({ name: "other", char: value, raw: value });

const OPTIONS = [{ label: "alpha", description: "first" }, { label: "beta" }, { label: "gamma" }];

const open = (checked?: boolean[]) => {
  const results: (number[] | undefined)[] = [];
  let renders = 0;

  const view = multiSelectForm({ title: "Skills", options: OPTIONS, checked })({
    theme: plainTheme,
    requestRender: () => {
      renders += 1;
    },
    done: (result) => {
      results.push(result);
    },
    createTextInput: () => {
      throw new Error("no text input");
    },
  });

  const press = (...keys: KeyPress[]) => {
    keys.forEach((pressed) => {
      view.handleKey(pressed);
    });
  };

  return { view, results, press, renders: () => renders };
};

describe("multiSelectForm", () => {
  it("renders checkbox rows pre-filled from the checked list, the pointer on the first row, hints", () => {
    expect(open([false, true]).view.render(60)).toEqual([
      "─".repeat(60),
      " Skills",
      "",
      " › [ ] alpha  first",
      "   [x] beta",
      "   [ ] gamma",
      "",
      " ↑↓ move · Space toggle · a all · n none · Enter confirm ·",
      " Esc cancel",
      "─".repeat(60),
    ]);
  });

  it("toggles the row under the pointer with Space and returns the checked indexes on Enter", () => {
    const form = open();

    form.press(key("space"), key("down"), key("down"), key("space"), key("up"), key("space"), key("space"));
    form.press(key("enter"));

    expect(form.results).toEqual([[0, 2]]);
    expect(form.renders()).toBeGreaterThan(0);
  });

  it("checks every row with a and none with n", () => {
    const all = open();
    const none = open([true, true, true]);

    all.press(char("a"), key("enter"));
    none.press(char("n"), key("enter"));

    expect(all.results).toEqual([[0, 1, 2]]);
    expect(none.results).toEqual([[]]);
  });

  it("returns nothing on Escape", () => {
    const form = open([true]);

    form.press(key("escape"));

    expect(form.results).toEqual([undefined]);
  });
});

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
