import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { seedText } from "../src/handoff.ts";
import { firstSentence, seedRow } from "../src/seed-row.ts";

const seed = seedText("/s/main.jsonl", "## Status\npartial\n\n## Outcome\nThe parser is fixed.");

describe("seedRow", () => {
  it("shows the title, the first sentence and the expand hint while collapsed", () => {
    expect(seedRow(seed, false, "ctrl+o")(200, plainTheme)).toEqual([
      "● Handoff from previous session",
      "  ⎿  This session continues the previous session /s/main.jsonl, which reached its context limit. (ctrl+o expand)",
    ]);
  });

  it("paints the bullet in the accent colour", () => {
    const theme: ThemeLike = { ...plainTheme, fg: (token, text) => `<${token}>${text}` };

    expect(seedRow(seed, false, "ctrl+o")(200, theme)[0]).toBe("<accent>● Handoff from previous session");
  });

  it("shows the whole seed, wrapped under the child glyph, when expanded", () => {
    const lines = seedRow(seed, true, "ctrl+o")(40, plainTheme);

    expect(lines[0]).toBe("● Handoff from previous session");
    expect(lines[1]?.startsWith("  ⎿  This session continues")).toBe(true);
    expect(lines).toContain("     ## Outcome");
    expect(lines.at(-1)).toBe("     The parser is fixed.");
    expect(lines.every((line) => plainTheme.width(line) <= 40)).toBe(true);
    expect(lines.some((line) => line.includes("expand)"))).toBe(false);
  });
});

describe("firstSentence", () => {
  it("ends at the first sentence mark followed by a space, keeping dots inside paths", () => {
    expect(firstSentence("Use a.ts first. Then more.")).toBe("Use a.ts first.");
    expect(firstSentence("No mark here\nnext")).toBe("No mark here");
  });
});
