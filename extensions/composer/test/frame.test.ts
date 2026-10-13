import { describe, expect, it } from "vitest";
import { createFrame, isRule } from "../src/frame.ts";

const ESC = String.fromCharCode(27);
const bold = (text: string) => `${ESC}[1m${ESC}[38;2;255;255;255m${text}${ESC}[39m${ESC}[22m`;

const plain = (text: string) => text;
const bracketed = (text: string) => `[${text}]`;

describe("isRule", () => {
  it("detects plain, coloured and scroll-hint rules but not content", () => {
    expect(isRule("──────")).toBe(true);
    expect(isRule(`${ESC}[38;5;240m──────${ESC}[39m`)).toBe(true);
    expect(isRule("─── ↑ 3 more ───")).toBe(true);
    expect(isRule(`${ESC}[2m── ↓ 12 more ──${ESC}[22m`)).toBe(true);
    expect(isRule("type here ")).toBe(false);
    expect(isRule("──── text")).toBe(false);
    expect(isRule(`${ESC}[7m ${ESC}[0m     `)).toBe(false);
  });
});

describe("createFrame", () => {
  it("reserves room for the pipes, the padding and the chevron gutter", () => {
    const frame = createFrame("❯");

    expect(frame.chrome).toBe(6);
    expect(frame.minWidth).toBe(14);
  });

  it("boxes the editor and puts the chevron only on the first content line", () => {
    const frame = createFrame("❯");
    const lines = frame.decorate(["────", "abcd", "efgh", "────"], plain);

    expect(lines).toEqual(["╭────────╮", `│ ${bold("❯")} abcd │`, "│   efgh │", "╰────────╯"]);
  });

  it("keeps every line as wide as the given width", () => {
    const frame = createFrame("❯");
    const visible = frame
      .decorate(["────", "abcd", "────"], plain)
      .map((line) => line.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "").length);

    expect(visible).toEqual([4 + frame.chrome, 4 + frame.chrome, 4 + frame.chrome]);
  });

  it("paints the border with the given colour", () => {
    const frame = createFrame(">");
    const lines = frame.decorate(["──", "ab", "──"], bracketed);

    expect(lines).toEqual(["[╭───]──[─╮]", `[│] ${bold(">")} ab [│]`, "[╰───]──[─╯]"]);
  });

  it("treats scroll hints as the top and bottom rules", () => {
    const frame = createFrame(">");
    const lines = frame.decorate(["─ ↑ 2 more ─", "ab", "─ ↓ 1 more ─"], plain);

    expect(lines).toEqual(["╭──── ↑ 2 more ──╮", `│ ${bold(">")} ab │`, "╰──── ↓ 1 more ──╯"]);
  });

  it("detects coloured rules", () => {
    const frame = createFrame(">");
    const rule = `${ESC}[38;5;240m──${ESC}[39m`;
    const lines = frame.decorate([rule, "ab", rule], plain);

    expect(lines[0]).toBe(`╭───${rule}─╮`);
    expect(lines[2]).toBe(`╰───${rule}─╯`);
  });

  it("indents lines below the bottom rule, such as autocomplete, outside the box", () => {
    const frame = createFrame(">");
    const lines = frame.decorate(["──", "ab", "──", "/help", "──"], plain);

    expect(lines.slice(3)).toEqual(["  /help", "  ──"]);
  });
});
