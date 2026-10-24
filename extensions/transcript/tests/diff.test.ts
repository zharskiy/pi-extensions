import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../pi-adapter/index.ts";
import { plainTheme, tokenTaggingTheme } from "../../../test-framework/index.ts";
import { diffRows, parseDiff } from "../src/diff.ts";

const tagged: ThemeLike = {
  ...tokenTaggingTheme(),
  bg: (token, text) => `<bg:${token}>${text}</bg>`,
  inverse: (text) => `<inv>${text}</inv>`,
};

const flat: ThemeLike = { ...tagged, panels: false };

const rows = (diff: string, width = 30, theme = tagged) => diffRows(parseDiff(diff) ?? [], width, theme);

const pad = (count: number) => " ".repeat(count);

const lead = (kind: "added" | "removed", gutter: string) =>
  `<bg:${kind}><${kind === "added" ? "success" : "error"}>${gutter[0]}</></bg><bg:${kind}><muted>${gutter.slice(1)}</></bg>`;

describe("diff rows on a theme with panels", () => {
  it("draws the mark, the right-aligned number and a space, then the line on its background to the width", () => {
    expect(rows("+1 one\n+2 two", 12)).toEqual([
      `${lead("added", "+1 ")}<bg:added>one${pad(6)}</bg>`,
      `${lead("added", "+2 ")}<bg:added>two${pad(6)}</bg>`,
    ]);
    expect(rows("-7 gone", 12)).toEqual([`${lead("removed", "-7 ")}<bg:removed>gone${pad(5)}</bg>`]);
  });

  it("highlights the changed words of a changed line pair", () => {
    expect(rows("-3 let total = 1;\n+3 let total = 2;", 20)).toEqual([
      `${lead("removed", "-3 ")}<bg:removed>let total = </bg><bg:removedWord>1</bg><bg:removed>;${pad(3)}</bg>`,
      `${lead("added", "+3 ")}<bg:added>let total = </bg><bg:addedWord>2</bg><bg:added>;${pad(3)}</bg>`,
    ]);
  });

  it("skips word highlighting when most of the line changed", () => {
    expect(rows("-1 alpha beta\n+1 gamma delta", 20)).toEqual([
      `${lead("removed", "-1 ")}<bg:removed>alpha beta${pad(7)}</bg>`,
      `${lead("added", "+1 ")}<bg:added>gamma delta${pad(6)}</bg>`,
    ]);
  });

  it("pairs a removed run with the following added run line by line, never the other way", () => {
    const [first, second, third] = rows("-1 a = 1;\n-2 b = 2;\n+1 a = 9;\n+2 b = 2;\n+3 c = 3;", 14);

    expect(first).toContain("<bg:removedWord>1</bg>");
    expect(second).toBe(`${lead("removed", "-2 ")}<bg:removed>b = 2;${pad(5)}</bg>`);
    expect(third).toContain("<bg:addedWord>9</bg>");
    expect(rows("+1 a = 9;\n-2 a = 1;", 14).join("")).not.toContain("Word");
  });

  it("draws context lines and the gap in muted with no background, the numbers padded to the widest", () => {
    expect(rows(" 9 keep\n+10 new\n    ...\n 99 tail", 14)).toEqual([
      "<muted>  9 keep</>",
      `${lead("added", "+10 ")}<bg:added>new${pad(7)}</bg>`,
      "<muted>...</>",
      "<muted> 99 tail</>",
    ]);
  });

  it("wraps a long line under a blank gutter that keeps the background", () => {
    expect(rows("-2 total = sum(values) if values else 0", 20, plainTheme)).toEqual(
      ["-2 total =", "   sum(values) if", "   values else 0"].map((line) => line.padEnd(20)),
    );
    expect(rows("+1 aaaa bbbb", 10, tagged)).toEqual([
      `${lead("added", "+1 ")}<bg:added>aaaa   </bg>`,
      `<bg:added>   </bg><bg:added>bbbb   </bg>`,
    ]);
  });

  it("keeps the changed-word background across a wrap", () => {
    const [first, second] = rows("-1 aaaa bbbb cccc\n+1 aaaa bbbb dddd", 12);

    expect(first).toBe(`${lead("removed", "-1 ")}<bg:removed>aaaa bbbb</bg>`);
    expect(second).toBe(`<bg:removed>   </bg><bg:removedWord>cccc</bg><bg:removed>${pad(5)}</bg>`);
  });

  it("expands tabs to three spaces and drops control characters", () => {
    expect(rows("+1 \tx", 12, plainTheme)).toEqual(["+1    x     "]);
    expect(rows(`+1 a${String.fromCharCode(7)}b\r`, 8, plainTheme)).toEqual(["+1 ab   "]);
  });

  it("keeps every row within the width, wide characters included", () => {
    [8, 12, 20].forEach((width) => {
      rows("-1 hello world 😀 日本語テキスト\n+1 hello world 😃 日本語テキスト", width, plainTheme).forEach(
        (row) => {
          expect(plainTheme.width(row)).toBeLessThanOrEqual(width);
        },
      );
    });
  });
});

describe("diff rows without panels", () => {
  it("colours whole changed lines and inverts the changed words, with no background", () => {
    expect(rows("-2 total = sum(values[1:])\n+2 total = sum(values)\n 3 keep", 40, flat)).toEqual([
      "<error>-2 </><error>total = sum(values</><inv><error>[1:]</></inv><error>)</>",
      "<success>+2 </><success>total = sum(values)</>",
      "<muted> 3 keep</>",
    ]);
  });

  it("wraps under a blank gutter", () => {
    expect(rows("+1 aaaa bbbb", 10, flat)).toEqual([
      "<success>+1 </><success>aaaa</>",
      "   <success>bbbb</>",
    ]);
  });
});

describe("parseDiff", () => {
  it("parses nothing from a diff it does not recognise", () => {
    expect(parseDiff("@@ -1 +1 @@\n-old\n+new")).toBeUndefined();
    expect(parseDiff("")).toBeUndefined();
    expect(parseDiff("+1 \n-2")).toEqual([
      { kind: "added", num: "1", text: "" },
      { kind: "removed", num: "2", text: "" },
    ]);
  });
});
