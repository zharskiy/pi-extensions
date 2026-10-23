import { describe, expect, it } from "vitest";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { CHEVRON, createFrame } from "../src/frame.ts";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const bold = (text: string) => `${ESC}[1m${text}${ESC}[22m`;

const plain = (text: string) => text;
const bracketed = (text: string) => `[${text}]`;
const layout = { bottom: 2, scrolled: false };
const visible = (line: string) => line.replaceAll(ANSI, "").length;

describe("createFrame", () => {
  it("reserves the margin and the chevron gutter", () => {
    const frame = createFrame();

    expect(frame.chrome).toBe(3);
    expect(frame.left).toBe(3);
    expect(frame.minWidth).toBe(11);
  });

  it("draws two full-width rules and puts the chevron only on the first content line", () => {
    const lines = createFrame().decorate(
      ["──────", "abcdef", "ghijkl", "──────"],
      { bottom: 3, scrolled: false },
      plain,
      plainTheme,
    );

    expect(lines).toEqual(["─────────", ` ${bold(CHEVRON)} abcdef`, "   ghijkl", "─────────"]);
  });

  it("keeps every line as wide as the given width", () => {
    const frame = createFrame();
    const width = 12;
    const lines = frame.decorate(
      [
        "─".repeat(width - frame.chrome),
        "abcd".padEnd(width - frame.chrome),
        "─".repeat(width - frame.chrome),
      ],
      layout,
      plain,
      plainTheme,
    );

    expect(lines.map(visible)).toEqual([width, width, width]);
  });

  it("extends a rule that carries a scroll hint and an ANSI colour to the full width", () => {
    const frame = createFrame();
    const rule = `${ESC}[31m─── ↑ 3 more ───${ESC}[39m`;
    const lines = frame.decorate([rule, "ab", "──"], layout, plain, plainTheme);

    expect(lines[0]).toBe(`───${rule}`);
    expect(visible(lines[0] ?? "")).toBe(visible(rule) + frame.chrome);
  });

  it("paints the extension and the chevron with the given colour", () => {
    const lines = createFrame().decorate(["──", "ab", "──"], layout, bracketed, plainTheme);

    expect(lines).toEqual(["[───]──", ` ${bold(`[${CHEVRON}]`)} ab`, "──[───]"]);
  });

  it("puts the extension in front of the top rule so pi's working status starts right of the gutter", () => {
    const frame = createFrame();
    const lines = frame.decorate(["── ⠋ Working ──", "ab", "──────────────"], layout, plain, plainTheme);

    expect(lines[0]).toBe("───── ⠋ Working ──");
    expect(lines[0]?.indexOf("⠋")).toBe(frame.chrome + 3);
  });

  it("puts the gutter space instead of the chevron while scrolled", () => {
    const lines = createFrame().decorate(
      ["─ ↑ 2 more ─", "ab", "cd", "──"],
      { bottom: 3, scrolled: true },
      plain,
      plainTheme,
    );

    expect(lines).toEqual(["──── ↑ 2 more ─", "   ab", "   cd", "─────"]);
  });

  it("indents lines below the bottom rule by the margin, so pi's list arrow sits under the chevron", () => {
    const lines = createFrame().decorate(["──", "ab", "──", "/help", "──"], layout, plain, plainTheme);

    expect(lines.slice(2)).toEqual(["─────", " /help", " ──"]);
  });

  it("leaves the lines unframed without a bottom rule", () => {
    expect(createFrame().decorate(["──", "ab"], { bottom: -1, scrolled: false }, plain, plainTheme)).toEqual([
      "──",
      "ab",
    ]);
  });
});
