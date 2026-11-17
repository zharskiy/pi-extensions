import { describe, expect, it } from "vitest";
import { renderFrame } from "../../../cli/prompt/frame.ts";
import { asciiOf, printable, truncate, widthOf, wrap, wrapSegments } from "../../../cli/prompt/style.ts";

describe("text width and truncation", () => {
  it("counts wide characters as two and ignores colour codes", () => {
    expect(widthOf("ab")).toBe(2);

    expect(widthOf("日本")).toBe(4);

    expect(widthOf("\x1b[36mab\x1b[39m")).toBe(2);
  });

  it("cuts a line to the width with an ellipsis and closes open colour", () => {
    expect(truncate("abcdef", 4, "…")).toBe("abc…");

    expect(truncate("abc", 4, "…")).toBe("abc");

    expect(truncate("\x1b[2mabcdef\x1b[22m", 4, "...")).toBe("\x1b[2ma\x1b[22m...\x1b[0m");

    expect(renderFrame(["x".repeat(10), "short"], 8)).toEqual(["xxxxxx…", "short"]);
  });

  it("wraps words keeping the indent, and key hints at their separators", () => {
    expect(wrap("  one two three", 9)).toEqual(["  one two", "  three"]);

    expect(wrapSegments(["a b", "c d", "e"], 9, " · ")).toEqual(["a b ·", "c d · e"]);
  });
});

describe("control characters and ASCII", () => {
  it("shows control characters as escapes", () => {
    expect(printable("a\x1b[2Jb\x7f\u009b")).toBe("a\\u001B[2Jb\\u007F\\u009B");
    expect(printable("a\u202eb\u2066c\u2028d")).toBe("a\\u202Eb\\u2066c\\u2028d");
    expect(printable("a\u200eb\u200fc\u061cd")).toBe("a\\u200Eb\\u200Fc\\u061Cd");
  });

  it("folds the Unicode punctuation to ASCII", () => {
    expect(asciiOf("Add another folder… · ✔ done → next")).toBe("Add another folder..., ok done -> next");
  });
});
