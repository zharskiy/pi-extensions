import { describe, expect, it } from "vitest";
import {
  alignRight,
  displayWidth,
  firstLine,
  formatAgents,
  formatCtx,
  formatDuration,
  formatTokens,
  formatToolUses,
  innerWidth,
  PAD,
  padEndCols,
  singleLine,
  truncateCols,
} from "../../src/components/format.ts";

describe("format helpers", () => {
  it("re-exports the core token and duration formatters", () => {
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatDuration(62_000)).toBe("1m 2s");
  });

  it("pluralises tool uses and agents", () => {
    expect(formatToolUses(1)).toBe("1 tool use");
    expect(formatToolUses(0)).toBe("0 tool uses");
    expect(formatToolUses(4)).toBe("4 tool uses");
    expect(formatAgents(1)).toBe("1 agent");
    expect(formatAgents(3)).toBe("3 agents");
  });

  it("formats context percent or nothing", () => {
    expect(formatCtx(23.4)).toBe("23% ctx");
    expect(formatCtx(undefined)).toBeUndefined();
    expect(formatCtx(null)).toBeUndefined();
  });

  it("measures display width with wide, combining and ANSI-coloured text", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("日本")).toBe(4);
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("\x1b[31mab\x1b[0m")).toBe(2);
    expect(displayWidth("⠹ ✓ …")).toBe(5);
    expect(displayWidth("🙂")).toBe(2);
  });

  it("truncates by columns with a trailing ellipsis", () => {
    expect(truncateCols("Map the auth module", 8)).toBe("Map the…");
    expect(truncateCols("日本語テキスト", 5)).toBe("日本…");
    expect(truncateCols("short", 10)).toBe("short");
    expect(truncateCols("Map the auth module", 14)).toBe("Map the auth…");
    expect(truncateCols("x", 0)).toBe("");
  });

  it("pads by columns", () => {
    expect(padEndCols("日本", 6)).toBe("日本  ");
    expect(padEndCols("abc", 2)).toBe("abc");
  });

  it("collapses whitespace and picks the first non-empty line", () => {
    expect(singleLine(" a \n b ")).toBe("a b");
    expect(firstLine("\n\n  x\ny")).toBe("x");
    expect(firstLine("")).toBe("");
  });

  it("computes the inner width inside the padding", () => {
    expect(PAD).toBe(" ");
    expect(innerWidth(80)).toBe(78);
    expect(innerWidth(2)).toBe(1);
    expect(innerWidth(0)).toBe(1);
  });

  it("aligns right inside the given columns", () => {
    expect(alignRight("hint", "1-9/9", 20)).toBe("hint           1-9/9");
    expect(displayWidth(alignRight("hint", "1-9/9", 20) ?? "")).toBe(20);
    expect(alignRight("日本", "x", 8)).toBe("日本   x");
  });

  it("returns undefined when both parts do not fit", () => {
    expect(alignRight("abcdefgh", "1-9/9", 14)).toBeUndefined();
    expect(displayWidth(alignRight("abcdefg", "1-9/9", 14) ?? "")).toBe(14);
  });
});
