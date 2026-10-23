import { describe, expect, it } from "vitest";
import { plainTheme } from "../../../../core/test/helpers/fakes.ts";
import {
  alignRight,
  cutChars,
  firstLine,
  singleLine,
  truncatePainted,
  wrapCols,
} from "../../src/components/format.ts";

describe("format helpers", () => {
  it("collapses whitespace and picks the first non-empty line", () => {
    expect(singleLine(" a \n b ")).toBe("a b");
    expect(firstLine("\n\n  x\ny")).toBe("x");
    expect(firstLine("")).toBe("");
  });

  it("cuts by characters with a trailing ellipsis", () => {
    expect(cutChars("Map the auth module", 8)).toBe("Map t...");
    expect(cutChars("short", 10)).toBe("short");
    expect(cutChars("x", 0)).toBe("...");
  });

  it("aligns right inside the given columns", () => {
    expect(alignRight(plainTheme, "hint", "1-9/9", 20)).toBe("hint           1-9/9");
    expect(plainTheme.width(alignRight(plainTheme, "hint", "1-9/9", 20) ?? "")).toBe(20);
    expect(alignRight(plainTheme, "日本", "x", 8)).toBe("日本   x");
  });

  it("returns undefined when both parts do not fit", () => {
    expect(alignRight(plainTheme, "abcdefgh", "1-9/9", 14)).toBeUndefined();
    expect(plainTheme.width(alignRight(plainTheme, "abcdefg", "1-9/9", 14) ?? "")).toBe(14);
  });

  it("cuts painted parts as one line and paints only what remains", () => {
    const parts = [
      ["Agents", (text: string) => `<b>${text}</b>`],
      [" · 3 running", (text: string) => `<dim>${text}</dim>`],
    ] as const;

    expect(truncatePainted(plainTheme, parts, 40)).toBe("<b>Agents</b><dim> · 3 running</dim>");
    expect(truncatePainted(plainTheme, parts, 10)).toBe("<b>Agents</b><dim> ...</dim>");
    expect(truncatePainted(plainTheme, parts, 4)).toBe("<b>A...</b>");
  });

  it("wraps at the column budget with at least one character per piece and whole wide characters", () => {
    expect(wrapCols(plainTheme, "abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(wrapCols(plainTheme, "", 3)).toEqual([""]);
    expect(wrapCols(plainTheme, "日本語", 1)).toEqual(["日", "本", "語"]);

    const pieces = wrapCols(plainTheme, "漢字".repeat(60), 39);

    expect(pieces.every((piece) => plainTheme.width(piece) <= 38)).toBe(true);
    expect(pieces.join("")).toBe("漢字".repeat(60));
  });
});
