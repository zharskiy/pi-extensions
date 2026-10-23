import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { diffRows, parseDiff } from "../src/diff.ts";

const tagged: ThemeLike = {
  ...plainTheme,
  fg: (token, text) => `<${token}>${text}</>`,
  bg: (token, text) => `<bg:${token}>${text}</bg>`,
};

const rows = (diff: string, width = 30, theme = tagged) => diffRows(parseDiff(diff) ?? [], width, theme);

const pad = (count: number) => " ".repeat(count);

describe("diff rows", () => {
  it("draws added lines with the number, the marker and the added background to the full width", () => {
    expect(rows("+1 one\n+2 two", 12)).toEqual([
      `<bg:added>1 <success>+</> one${pad(5)}</bg>`,
      `<bg:added>2 <success>+</> two${pad(5)}</bg>`,
    ]);
  });

  it("draws removed lines on the removed background", () => {
    expect(rows("-7 gone", 12)).toEqual([`<bg:removed>7 <error>-</> gone${pad(4)}</bg>`]);
  });

  it("highlights the changed words of a changed line pair", () => {
    expect(rows("-3 let total = 1;\n+3 let total = 2;", 22)).toEqual([
      `<bg:removed>3 <error>-</> let total = </bg><bg:removedWord>1</bg><bg:removed>;${pad(4)}</bg>`,
      `<bg:added>3 <success>+</> let total = </bg><bg:addedWord>2</bg><bg:added>;${pad(4)}</bg>`,
    ]);
  });

  it("skips word highlighting when most of the line changed", () => {
    expect(rows("-1 alpha beta\n+1 gamma delta", 20)).toEqual([
      `<bg:removed>1 <error>-</> alpha beta${pad(6)}</bg>`,
      `<bg:added>1 <success>+</> gamma delta${pad(5)}</bg>`,
    ]);
  });

  it("pairs a removed run with the following added run line by line", () => {
    const [first, second, third] = rows("-1 a = 1;\n-2 b = 2;\n+1 a = 9;\n+2 b = 2;\n+3 c = 3;", 14);

    expect(first).toContain("<bg:removedWord>1</bg>");
    expect(second).toBe(`<bg:removed>2 <error>-</> b = 2;${pad(4)}</bg>`);
    expect(third).toContain("<bg:addedWord>9</bg>");
  });

  it("dims context lines and the gap between hunks, with the numbers padded to the widest", () => {
    expect(rows(" 9 keep\n+10 new\n    ...\n 99 tail", 14)).toEqual([
      "<dim> 9   keep</>",
      `<bg:added>10 <success>+</> new${pad(6)}</bg>`,
      "<dim>     ...</>",
      "<dim>99   tail</>",
    ]);
  });

  it("truncates long lines at the width with an ellipsis instead of wrapping", () => {
    expect(rows("+1 abcdefghijklmnop", 10, plainTheme)).toEqual(["1 + abcde…"]);
    expect(rows(" 1 abcdefghijklmnop", 10, plainTheme)).toEqual(["1   abcde…"]);
    expect(rows("-1 let total = 1;\n+1 let total = 2;", 12, plainTheme)).toEqual([
      "1 - let tot…",
      "1 + let tot…",
    ]);
  });

  it("expands tabs", () => {
    expect(rows("+1 \tx", 12, plainTheme)).toEqual(["1 +     x   "]);
  });

  it("parses nothing from a diff it does not recognise", () => {
    expect(parseDiff("@@ -1 +1 @@\n-old\n+new")).toBeUndefined();
    expect(parseDiff("")).toBeUndefined();
    expect(parseDiff("+1 \n-2")).toEqual([
      { kind: "add", num: "1", text: "" },
      { kind: "del", num: "2", text: "" },
    ]);
  });
});
