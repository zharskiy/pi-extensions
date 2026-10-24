import { describe, expect, it } from "vitest";
import { paintRecordingTheme, plainTheme } from "../../../test/framework/index.ts";
import { seedText } from "../core/handoff.ts";
import { firstSentence, seedRow } from "../ui/seed-row.ts";

const seed = seedText("/s/main.jsonl", "## Status\npartial\n\n## Outcome\nThe parser is fixed.");

const padded = (lines: string[]) => lines.map((line) => (line === "" ? "" : ` ${line}`));

describe("seedRow", () => {
  it("shows the info marker, the title and the first sentence cut so the hint keeps its place", () => {
    expect(padded(seedRow(seed, false, "ctrl+o")(79, plainTheme))).toEqual([
      " » Handoff from the previous session",
      "   ↳ This session continues the previous session /s/main.j... (ctrl+o to expand)",
    ]);
  });

  it("lets the hint give way at 40 columns", () => {
    expect(padded(seedRow(seed, false, "ctrl+o")(39, plainTheme))).toEqual([
      " » Handoff from the previous session",
      "   ↳ This session continues the previ...",
    ]);
  });

  it("paints the marker in accent, the title bold, the summary muted and the hint dim", () => {
    const { theme, painted, bolded } = paintRecordingTheme();

    seedRow(seed, false, "ctrl+o")(200, theme);

    const tokenOf = (text: string) => painted.find((entry) => entry.text === text)?.token;

    expect(tokenOf("»")).toBe("accent");
    expect(tokenOf("↳")).toBe("dim");
    expect(tokenOf(firstSentence(seed))).toBe("muted");
    expect(tokenOf("(ctrl+o to expand)")).toBe("dim");
    expect(bolded).toContain("Handoff from the previous session");
  });

  it("shows the whole seed wrapped at column 4 without a hint when expanded", () => {
    const lines = seedRow(seed, true, "ctrl+o")(40, plainTheme);

    expect(lines[0]).toBe("» Handoff from the previous session");
    expect(lines[1]?.startsWith("  ↳ This session continues")).toBe(true);
    expect(lines).toContain("    ## Outcome");
    expect(lines.at(-1)).toBe("    The parser is fixed.");
    expect(lines.every((line) => plainTheme.width(line) <= 40)).toBe(true);
    expect(lines.some((line) => line.includes("expand)"))).toBe(false);
  });

  it("has no hint when the expand key is unbound", () => {
    expect(seedRow(seed, false, "")(200, plainTheme)[1]?.endsWith("context limit.")).toBe(true);
  });
});

describe("firstSentence", () => {
  it("ends at the first sentence mark followed by a space, keeping dots inside paths", () => {
    expect(firstSentence("Use a.ts first. Then more.")).toBe("Use a.ts first.");
    expect(firstSentence("No mark here\nnext")).toBe("No mark here");
  });
});
