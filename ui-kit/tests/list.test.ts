import { describe, expect, it } from "vitest";
import type { KeyPress, ThemeLike } from "../../pi-adapter/index.ts";
import { char, key, plainTheme, tokenTaggingTheme } from "../../test-framework/index.ts";
import { keyHints } from "../key-hints.ts";
import { CANCEL_HINT, listKey, listLines, SELECT_HINTS } from "../list.ts";

const tagged: ThemeLike = tokenTaggingTheme();

const options = [
  { label: "Alpha", description: "first one" },
  { label: "Beta", mark: "✓" },
  { label: "Gamma", description: "third one" },
];

const rows = (selected: number) => listLines(plainTheme, options, selected, 40, { layout: "beside" });

const moved = (keyPress: KeyPress, from: number) => {
  const step = listKey(keyPress, from, options.length);

  return step ? rows(step.index) : undefined;
};

describe("listLines", () => {
  it("puts descriptions below the label by default and beside it on request, with a space before the mark", () => {
    expect(listLines(plainTheme, options, 0, 40)).toEqual([
      " › 1. Alpha",
      "      first one",
      "   2. Beta ✓",
      "   3. Gamma",
      "      third one",
    ]);
    expect(rows(1)).toEqual(["   1. Alpha  first one", " › 2. Beta ✓", "   3. Gamma  third one"]);
  });

  it("paints the selected and active rows in the accent colour and descriptions muted", () => {
    const [first, second, third] = listLines(
      tagged,
      [{ label: "One" }, { label: "Two", active: true }, { label: "Three", description: "more" }],
      0,
      40,
      { layout: "beside" },
    );

    expect(first).toContain("<accent>1. One");
    expect(second).toContain("<accent>2. Two");
    expect(third).toContain("<text>3. Three");
    expect(third).toContain("<muted>more");
  });

  it("wraps a long label under the pointer at a narrow width", () => {
    expect(listLines(plainTheme, [{ label: "A rather long option label" }], 0, 14)).toEqual([
      " › 1. A rather",
      "   long option",
      "   label",
    ]);
  });
});

describe("listKey", () => {
  it("moves the pointer with the arrows, Home and End, and stops at both ends", () => {
    expect(moved(key("down"), 0)?.[1]).toBe(" › 2. Beta ✓");
    expect(moved(key("up"), 0)?.[0]).toBe(" › 1. Alpha  first one");
    expect(moved(key("down"), 2)?.[2]).toBe(" › 3. Gamma  third one");
    expect(moved(key("end"), 0)?.[2]).toBe(" › 3. Gamma  third one");
    expect(moved(key("home"), 2)?.[0]).toBe(" › 1. Alpha  first one");
  });

  it("picks the current row with Enter and a row by its digit, and ignores other keys", () => {
    expect(listKey(key("enter"), 1, 3)).toMatchObject({ index: 1, pick: true });
    expect(listKey(char("3"), 0, 3)).toMatchObject({ index: 2, pick: true });
    expect(listKey(char("4"), 0, 3)).toBeUndefined();
    expect(listKey(char("0"), 0, 3)).toBeUndefined();
    expect(listKey(key("tab"), 0, 3)).toBeUndefined();
  });
});

describe("list hints", () => {
  it("phrase each key as key to verb, keys dim and words muted", () => {
    expect(keyHints([...SELECT_HINTS, CANCEL_HINT], plainTheme)).toBe(
      "↑↓ to select · 1-9 to pick · esc to cancel",
    );
    expect(keyHints([CANCEL_HINT], tagged)).toBe("<dim>esc</> <muted>to cancel</>");
  });
});
