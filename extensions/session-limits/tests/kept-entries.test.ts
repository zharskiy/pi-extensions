import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../platform/pi-adapter/index.ts";
import { plainTheme, tokenTaggingTheme } from "../../../test/framework/index.ts";
import { keptMessage, keptRule } from "../ui/kept-entries.ts";

const backgroundTheme: ThemeLike = {
  ...tokenTaggingTheme(),
  bg: (token, text) => `[${token}]${text}[/]`,
};

describe("kept message", () => {
  it("paints pi's user message background over every full-width row, from the first column", () => {
    const lines = keptMessage({ text: "hi", images: 0 }, 10, false, backgroundTheme, 1);

    expect(lines.every((line) => line.startsWith("[userMessage]") && line.endsWith("[/]"))).toBe(true);
    expect(lines[0]).toBe(`[userMessage]${" ".repeat(10)}[/]`);
    expect(lines[1]?.startsWith("[userMessage] <userMessageText>hi</>")).toBe(true);
  });

  it("starts the text after pi's pad and keeps a blank row above and below", () => {
    expect(keptMessage({ text: "hi", images: 0 }, 10, false, plainTheme, 2)).toEqual([
      " ".repeat(10),
      "  hi      ",
      " ".repeat(10),
    ]);
  });

  it("wraps long text inside the pad on both sides and adds a muted image count", () => {
    const lines = keptMessage({ text: "one two three", images: 2 }, 10, false, plainTheme, 1);

    expect(lines).toEqual([" ".repeat(10), " one two  ", " three    ", " 2 images ", " ".repeat(10)]);
  });

  it("draws nothing for data it does not know", () => {
    expect(keptMessage({ text: 1 }, 10, false, plainTheme, 1)).toEqual([]);
    expect(keptRule({ state: "other" }, 10, false, plainTheme, 1)).toEqual([]);
  });
});
