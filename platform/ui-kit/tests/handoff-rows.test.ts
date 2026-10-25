import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paintRecordingTheme, plainTheme, tokenTaggingTheme } from "../../../test/framework/index.ts";
import type { ThemeLike, ToolRender, ToolRenderState } from "../../pi-adapter/index.ts";
import { seedText, successorPreface } from "../../shared/index.ts";
import { handoffSeedMessage, handoffToolRows } from "../handoff-rows.ts";

const seed = seedText(
  successorPreface({ kind: "session", file: "/s/main.jsonl", manual: false }),
  "## Status\npartial\n\n## Outcome\nThe parser is fixed.",
);

const padded = (lines: string[]) => lines.map((line) => (line === "" ? "" : ` ${line}`));

const seedMessage = (details?: unknown) => ({ text: seed, details });

const draw = (expanded: boolean, width: number, details?: unknown, key = "ctrl+o") =>
  handoffSeedMessage(() => key)(seedMessage(details), width, expanded, plainTheme);

describe("handoff seed message", () => {
  it("shows the info marker, the title and the first sentence cut so the hint keeps its place", () => {
    expect(padded(draw(false, 79))).toEqual([
      " » Handoff from the previous session",
      "   ↳ This session continues the previous session /s/main.j... (ctrl+o to expand)",
    ]);
  });

  it("lets the hint give way at 40 columns", () => {
    expect(padded(draw(false, 39))).toEqual([
      " » Handoff from the previous session",
      "   ↳ This session continues the previ...",
    ]);
  });

  it("paints the marker in accent, the title bold, the summary muted and the hint dim", () => {
    const { theme, painted, bolded } = paintRecordingTheme();

    handoffSeedMessage(() => "ctrl+o")(seedMessage(), 200, false, theme);

    const tokenOf = (text: string) => painted.find((entry) => entry.text === text)?.token;

    expect(tokenOf("»")).toBe("accent");
    expect(tokenOf("↳")).toBe("dim");
    expect(
      tokenOf("This session continues the previous session /s/main.jsonl, which reached its context limit."),
    ).toBe("muted");
    expect(tokenOf("(ctrl+o to expand)")).toBe("dim");
    expect(bolded).toContain("Handoff from the previous session");
  });

  it("shows the whole seed wrapped at column 4 without a hint when expanded", () => {
    const lines = draw(true, 40);

    expect(lines[0]).toBe("» Handoff from the previous session");
    expect(lines[1]?.startsWith("  ↳ This session continues")).toBe(true);
    expect(lines).toContain("    ## Outcome");
    expect(lines.at(-1)).toBe("    The parser is fixed.");
    expect(lines.every((line) => plainTheme.width(line) <= 40)).toBe(true);
    expect(lines.some((line) => line.includes("expand)"))).toBe(false);
  });

  it("has no hint when the expand key is unbound", () => {
    expect(draw(false, 200, undefined, "")[1]?.endsWith("context limit.")).toBe(true);
  });

  it("cuts the summary at the first sentence mark followed by a space, keeping dots inside paths", () => {
    const summaryOf = (text: string) =>
      handoffSeedMessage(() => "ctrl+o")({ text }, 200, false, plainTheme)[1]?.replace(
        / \(ctrl\+o to expand\)$/,
        "",
      );

    expect(summaryOf("Use a.ts first. Then more.")).toBe("  ↳ Use a.ts first.");
    expect(summaryOf("No mark here\nnext")).toBe("  ↳ No mark here");
  });

  it("names the agent and the link in the title of an agent-origin seed", () => {
    expect(draw(false, 200, { from: "agent", id: "scout-1", link: 2 })[0]).toBe(
      "» Handoff from agent scout-1 · link 2",
    );
    expect(draw(false, 200, { from: "session" })[0]).toBe("» Handoff from the previous session");
  });
});

const state = (patch: Partial<ToolRenderState> = {}): ToolRenderState => ({
  aborted: false,
  expanded: false,
  isPartial: false,
  isError: false,
  args: {},
  invalidate: () => {},
  ...patch,
});

const drawn = (render: ToolRender | undefined) => (typeof render === "function" ? render(80) : render);

const tagged: ThemeLike = tokenTaggingTheme({ close: () => "" });

describe("handoff tool rows", () => {
  const rows = handoffToolRows(() => join(homedir(), "work", "handoff.md"));

  it("draws the bold title with its state mark", () => {
    expect(drawn(rows.renderCall?.({ content: "" }, plainTheme, state()))).toBe("✓ handoff");
  });

  it("names the saved file under the home directory, or the error lines", () => {
    expect(drawn(rows.renderResult?.({ text: "Handoff saved" }, state(), plainTheme))).toBe(
      "  ↳ Saved ~/work/handoff.md",
    );
    expect(drawn(rows.renderResult?.({ text: "Error: bad\nmore", isError: true }, state(), tagged))).toBe(
      ["  <dim>↳ <error>Error: bad", "    <error>more"].join("\n"),
    );
  });
});
