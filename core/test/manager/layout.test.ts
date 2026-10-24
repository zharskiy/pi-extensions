import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../pi-adapter/index.ts";
import { hintLines, keyHints } from "../../manager/hints.ts";
import { padded, prefixed, rule } from "../../manager/layout.ts";
import { plainTheme, taggedTheme } from "../helpers/fakes.ts";

const tagged: ThemeLike = taggedTheme();

describe("rule", () => {
  it("draws an accent line across the width, at least one column wide", () => {
    expect(rule(plainTheme, 5)).toBe("─────");
    expect(rule(plainTheme, 0)).toBe("─");
    expect(rule(tagged, 3)).toContain("<accent>");
  });
});

describe("prefixed", () => {
  it("puts the prefix before the first line and indents the wrapped rest under it", () => {
    expect(prefixed(plainTheme, " > ", "one two three four", 12)).toEqual([
      " > one two",
      "   three",
      "   four",
    ]);
  });
});

describe("padded", () => {
  it("indents every wrapped line by one column", () => {
    expect(padded(plainTheme, "alpha beta gamma", 12)).toEqual([" alpha beta", " gamma"]);
  });
});

describe("hintLines", () => {
  it("wraps between hints, never inside one", () => {
    const hints = [
      ["↑↓", "to select"],
      ["enter", "to choose"],
      ["esc", "to cancel"],
    ] as const;

    expect(hintLines(plainTheme, hints, 34)).toEqual([" ↑↓ to select · enter to choose", " esc to cancel"]);
    expect(hintLines(plainTheme, [["enter", "to save the whole thing"]], 12)).toEqual([" enter to..."]);
  });

  it("joins the hints with a dot in the dim colour", () => {
    expect(
      hintLines(
        plainTheme,
        [
          ["enter", "to save"],
          ["esc", "to go back"],
        ],
        40,
      ),
    ).toEqual([" enter to save · esc to go back"]);
    expect(hintLines(tagged, [["enter", "to save"]], 40)[0]).toBe(" <dim>enter</> <muted>to save</>");
  });
});

describe("keyHints", () => {
  it("joins key-to-verb pairs with keys dim, words muted and a dim dot", () => {
    const pairs = [
      ["enter", "to view"],
      ["x", "to stop"],
    ] as const;

    expect(keyHints(pairs, plainTheme)).toBe("enter to view · x to stop");
    expect(keyHints(pairs, tagged)).toBe(
      "<dim>enter</> <muted>to view</><dim> · </><dim>x</> <muted>to stop</>",
    );
  });
});
