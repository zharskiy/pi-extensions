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

  it("keeps the ellipsis when the cut lands right after a changed word", () => {
    expect(rows("-1 ab cde f\n+1 ab cdx f", 10)).toEqual([
      "<bg:removed>1 <error>-</> ab </bg><bg:removedWord>cd…</bg>",
      "<bg:added>1 <success>+</> ab </bg><bg:addedWord>cd…</bg>",
    ]);
  });

  it("cuts wide characters by their width and never splits an emoji", () => {
    const [old, now] = rows("-1 hello world 😀\n+1 hello world 😃", 24);
    const [cjk] = rows("+1 日本語テキスト", 10, plainTheme);

    expect(old).toContain("<bg:removedWord>😀</bg>");
    expect(now).toContain("<bg:addedWord>😃</bg>");
    expect([old, now].some((row) => /\p{Cs}/u.test(row ?? ""))).toBe(false);
    expect(cjk).toBe("1 + 日本… ");
    expect(plainTheme.width(cjk ?? "")).toBe(10);
  });

  it("pairs only the first lines of a longer removed run", () => {
    expect(rows("-1 a = 1;\n-2 b = 2;\n-3 c = 3;\n+1 a = 9;", 14)).toEqual([
      `<bg:removed>1 <error>-</> a = </bg><bg:removedWord>1</bg><bg:removed>;${pad(4)}</bg>`,
      `<bg:removed>2 <error>-</> b = 2;${pad(4)}</bg>`,
      `<bg:removed>3 <error>-</> c = 3;${pad(4)}</bg>`,
      `<bg:added>1 <success>+</> a = </bg><bg:addedWord>9</bg><bg:added>;${pad(4)}</bg>`,
    ]);
  });

  it("does not pair an added run with the removed run after it", () => {
    expect(rows("+1 a = 9;\n-2 a = 1;", 14)).toEqual([
      `<bg:added>1 <success>+</> a = 9;${pad(4)}</bg>`,
      `<bg:removed>2 <error>-</> a = 1;${pad(4)}</bg>`,
    ]);
  });

  it("draws a diff that starts with a gap", () => {
    expect(rows("    ...\n 40 keep\n+41 new", 14)).toEqual([
      "<dim>     ...</>",
      "<dim>40   keep</>",
      `<bg:added>41 <success>+</> new${pad(6)}</bg>`,
    ]);
  });

  it("expands tabs to three spaces and drops control characters", () => {
    expect(rows("+1 \tx", 12, plainTheme)).toEqual(["1 +    x    "]);
    expect(rows(`+1 a${String.fromCharCode(7)}b\r`, 8, plainTheme)).toEqual(["1 + ab  "]);
  });

  it("parses nothing from a diff it does not recognise", () => {
    expect(parseDiff("@@ -1 +1 @@\n-old\n+new")).toBeUndefined();
    expect(parseDiff("")).toBeUndefined();
    expect(parseDiff("+1 \n-2")).toEqual([
      { kind: "added", num: "1", text: "" },
      { kind: "removed", num: "2", text: "" },
    ]);
  });
});
