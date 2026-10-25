import { describe, expect, it } from "vitest";
import { plainTheme, tokenTaggingTheme } from "../../../test/framework/index.ts";
import type { ThemeLike } from "../../pi-adapter/index.ts";
import { padded, prefixed } from "../../shared/index.ts";
import { framed, hintRow, keyHints, rule } from "../key-hints.ts";

const tagged: ThemeLike = tokenTaggingTheme();

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

describe("framed hint strip", () => {
  const strip = (theme: ThemeLike, hints: readonly (readonly [string, string])[], width: number) =>
    framed(theme, width, [], hints).slice(2, -1);

  it("wraps between hints, never inside one", () => {
    const hints = [
      ["↑↓", "to select"],
      ["enter", "to choose"],
      ["esc", "to cancel"],
    ] as const;

    expect(strip(plainTheme, hints, 34)).toEqual([" ↑↓ to select · enter to choose", " esc to cancel"]);
    expect(strip(plainTheme, [["enter", "to save the whole thing"]], 12)).toEqual([" enter to..."]);
  });

  it("joins the hints with a dot in the dim colour", () => {
    expect(
      strip(
        plainTheme,
        [
          ["enter", "to save"],
          ["esc", "to go back"],
        ],
        40,
      ),
    ).toEqual([" enter to save · esc to go back"]);
    expect(strip(tagged, [["enter", "to save"]], 40)[0]).toBe(" <dim>enter</> <muted>to save</>");
  });
});

describe("hintRow", () => {
  it("keeps the hints on one row after the pad, cut with an ellipsis", () => {
    const hints = [
      ["enter", "to view"],
      ["x", "to stop"],
    ] as const;

    expect(hintRow(plainTheme, hints, 40)).toBe(" enter to view · x to stop");
    expect(hintRow(plainTheme, hints, 16)).toBe(" enter to vie...");
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

describe("framed", () => {
  const hints = [
    ["↑↓", "to select"],
    ["enter", "to confirm"],
    ["esc", "to cancel"],
  ] as const;

  it("wraps the hints between rules by default", () => {
    expect(framed(plainTheme, 20, ["body"], hints)).toEqual([
      "─".repeat(20),
      "body",
      "",
      " ↑↓ to select",
      " enter to confirm",
      " esc to cancel",
      "─".repeat(20),
    ]);
  });

  it("keeps the hints on one row cut with an ellipsis when asked for one row", () => {
    expect(framed(plainTheme, 30, ["body"], hints, { oneRow: true })).toEqual([
      "─".repeat(30),
      "body",
      "",
      " ↑↓ to select · enter to co...",
      "─".repeat(30),
    ]);
  });
});
