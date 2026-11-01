import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../platform/pi-adapter/index.ts";
import { plainTheme, tokenTaggingTheme } from "../../../test/framework/index.ts";
import { keptMessage, keptRule } from "../ui/kept-entries.ts";

const backgroundTheme: ThemeLike = {
  ...tokenTaggingTheme(),
  bg: (token, text) => `[${token}]${text}[/]`,
};

describe("kept message", () => {
  it("draws the text on pi's user message background, every row as wide as the entry", () => {
    const lines = keptMessage({ text: "hi", images: 0 }, 10, false, backgroundTheme);

    expect(lines.every((line) => line.startsWith("[userMessage]") && line.endsWith("[/]"))).toBe(true);
    expect(lines.join("\n")).toContain("<userMessageText>hi</>");
    expect(keptMessage({ text: "hi", images: 0 }, 10, false, plainTheme).map((line) => line.length)).toEqual([
      10, 10, 10,
    ]);
  });

  it("wraps long text and adds a muted image count", () => {
    const lines = keptMessage({ text: "one two three", images: 2 }, 10, false, plainTheme);

    expect(lines.map((line) => line.trim()).filter(Boolean)).toEqual(["one two", "three", "2 images"]);
  });

  it("draws nothing for data it does not know", () => {
    expect(keptMessage({ text: 1 }, 10, false, plainTheme)).toEqual([]);
    expect(keptRule({ state: "other" }, 10, false, plainTheme)).toEqual([]);
  });
});
