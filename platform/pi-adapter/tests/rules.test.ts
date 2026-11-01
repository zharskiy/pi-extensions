import { describe, expect, it } from "vitest";
import { plainTheme, tokenTaggingTheme } from "../../../test/framework/index.ts";
import type { ThemeLike } from "../index.ts";
import { labelledRule } from "../ui/rules.ts";

const tagged: ThemeLike = tokenTaggingTheme();

describe("labelledRule", () => {
  it("fills the width after the label and paints it dim", () => {
    const line = labelledRule(plainTheme, 60, "worked 42s");

    expect(line.startsWith("── worked 42s ─")).toBe(true);
    expect(plainTheme.width(line)).toBe(60);
    expect(labelledRule(tagged, 60, "worked 42s")).toMatch(/^<dim>── worked 42s /);
  });

  it("cuts a label that does not fit and keeps the width", () => {
    const line = labelledRule(plainTheme, 12, "worked 42s");

    expect(line).toContain("...");
    expect(plainTheme.width(line)).toBe(12);
  });

  it("paints the line in the given token", () => {
    expect(labelledRule(tagged, 60, "not found", "warning")).toMatch(/^<warning>── not found /);
  });

  it("draws only the line below six columns", () => {
    expect(labelledRule(plainTheme, 4, "worked 42s")).toBe("────");
    expect(labelledRule(plainTheme, 0, "worked 42s")).toBe("─");
  });
});
