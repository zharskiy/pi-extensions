import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../pi-adapter/index.ts";
import { plainTheme, tokenTaggingTheme } from "../../../test-framework/index.ts";
import { renderSnapshot } from "../ui/render.ts";
import { summaryLine } from "../ui/summary.ts";
import { breakdown, snapshot, usage } from "./support/context-snapshots.ts";

const tokenTheme: ThemeLike = tokenTaggingTheme({ close: () => "" });

const cacheLine = (lines: string[]) => lines.find((line) => line.includes("Cache hit:"));

const render = (
  patch = {},
  options: Partial<{ width: number; expanded: boolean }> = {},
  theme = plainTheme,
) => renderSnapshot(theme, snapshot(patch), { width: 79, expanded: false, expandKey: "ctrl+o", ...options });

describe("renderSnapshot", () => {
  it("draws the grid beside the header, cache line and legend, then one summary per section and the count line", () => {
    expect(render()).toEqual([
      "» Context usage · 14:32",
      "    ■ ■ ■ ■ ■ ■ ■ ■ ■ ■   Test Model · 61.2k/200k tokens (31%)",
      "    ■ ■ ■ ■ ■ ■ ■ ■ ■ ■   Cache hit: last turn 87% · session 91%",
      "    ■ ■ ■ ■ ■ ■ ■ ■ ■ ■",
      "    ■ · · · · · · · · ·   Estimated usage by category",
      "    · · · · · · · · · ·   ■ System prompt: 4.1k tokens (2.1%)",
      "    · · · · · · · · · ·   ■ System tools: 5.3k tokens (2.6%)",
      "    · · · · · · · · · ·   ■ MCP tools: 1.8k tokens (0.9%)",
      "    · · · · · · · · · ·   ■ Extension tools: 2.6k tokens (1.3%)",
      "    · · · · · · · · · ·   ■ Memory files: 3.2k tokens (1.6%)",
      "    · · ░ ░ ░ ░ ░ ░ ░ ░   ■ Skills: 1.4k tokens (0.7%)",
      "                          ■ Messages: 42.8k tokens (21.4%)",
      "                          · Free space: 122.4k (61.2%)",
      "                          ░ Compaction reserve: 16.4k tokens (8.2%)",
      "",
      "    Memory files · AGENTS.md",
      "    ↳ 2 files · 3.2k tokens",
      "    Skills · /skill:<name>",
      "    ↳ 2 skills · 1.4k tokens",
      "    MCP tools · /mcp",
      "    ↳ 2 tools · 1.8k tokens · 1 loaded on demand",
      "    Extension tools",
      "    ↳ 1 tool · 2.6k tokens",
      "    Messages",
      "    ↳ 38 messages · tool results 31.0k · assistant 7.9k · user 2.1k · thinki...",
      "    ... (14 more items, ctrl+o to expand)",
    ]);
  });

  it("stacks a 5 x 5 grid over the legend at 40 columns and drops the unit from a header that does not fit", () => {
    const lines = render({}, { width: 39 });

    expect(lines.slice(0, 9)).toEqual([
      "» Context usage · 14:32",
      "    ■ ■ ■ ■ ■",
      "    ■ ■ ■ · ·",
      "    · · · · ·",
      "    · · · · ·",
      "    · · · ░ ░",
      "    Test Model · 61.2k/200k (31%)",
      "    Cache hit: last turn 87% · sessi...",
      "",
    ]);
    expect(lines.at(-1)).toBe("    ... (14 more items)");
    expect(lines.every((line) => plainTheme.width(line) <= 39)).toBe(true);
  });

  it("paints the info marker in accent, the title bold and the time dim", () => {
    const bolded: string[] = [];
    const theme: ThemeLike = {
      ...tokenTheme,
      bold: (text) => {
        bolded.push(text);
        return text;
      },
    };
    const lines = render({}, {}, theme);

    expect(lines[0]).toBe("<accent>» Context usage<dim> · 14:32");
    expect(bolded).toContain("Context usage");
    expect(lines).toContain("    <dim>↳ <muted>2 files · 3.2k tokens");
    expect(lines.at(-1)).toBe("    <muted>... (14 more items, <dim>ctrl+o<muted> to expand)");
  });

  it("colours each category with pi's thinking-level ramp, messages in text, and no syntax tokens", () => {
    const lines = render({}, { width: 300 }, tokenTheme).join("\n");

    expect(
      [
        "<thinkingOff>■ System prompt",
        "<thinkingMinimal>■ System tools",
        "<thinkingLow>■ MCP tools",
        "<thinkingMedium>■ Extension tools",
        "<thinkingHigh>■ Memory files",
        "<thinkingXhigh>■ Skills",
        "<text>■ Messages",
        "<muted>· Free space",
        "<warning>░ Compaction reserve",
        "<text>Test Model",
      ].filter((text) => !lines.includes(text)),
    ).toEqual([]);
    expect(lines).not.toMatch(/<(comment|keyword|function|string|number|type|heading|error)>/);
  });

  it("lists every item by tokens when expanded, system tools included, without a count line", () => {
    const lines = render({}, { expanded: true });

    expect(lines.slice(lines.indexOf("    Memory files · AGENTS.md"))).toEqual([
      "    Memory files · AGENTS.md",
      "    ↳ ./AGENTS.md: 2.1k tokens",
      "      ~/.pi/agent/AGENTS.md: 1.1k tokens",
      "    Skills · /skill:<name>",
      "    ↳ code-style: 900 tokens",
      "      commits: 500 tokens",
      "    MCP tools · /mcp",
      "    ↳ search_docs: 1.8k tokens",
      "      fetch_page: loaded on demand",
      "    Extension tools",
      "    ↳ run_agent: 2.6k tokens",
      "    System tools",
      "    ↳ read: 3.1k tokens",
      "      bash: 1.2k tokens",
      "      edit: 980 tokens",
      "    Messages",
      "    ↳ tool results: 31.0k tokens",
      "      assistant: 7.9k tokens",
      "      user: 2.1k tokens",
      "      thinking: 1.8k tokens",
    ]);
  });

  it("expands without a hint for /context all", () => {
    const lines = render({ expandedByDefault: true });

    expect(lines).toContain("      commits: 500 tokens");
    expect(lines.some((line) => line.includes("expand)"))).toBe(false);
  });

  it("drops the key from the count line when it is unbound", () => {
    const lines = renderSnapshot(plainTheme, snapshot(), { width: 79, expanded: false, expandKey: "" });

    expect(lines.at(-1)).toBe("    ... (14 more items)");
  });

  it("hides zero rows and empty sections", () => {
    const lines = render({
      breakdown: breakdown({
        memoryFiles: [],
        skills: [],
        tools: { builtin: [{ name: "bash", tokens: 1_000 }], mcp: [], extension: [] },
        reserve: 0,
      }),
    });

    expect(lines.filter((line) => line.includes("Memory files") || line.includes("Skills"))).toEqual([]);
    expect(lines.some((line) => line.includes("MCP tools") || line.includes("Compaction reserve"))).toBe(
      false,
    );
    expect(lines.some((line) => line.includes("Extension tools"))).toBe(false);
    expect(lines).toContain("    Messages");
  });

  it("leaves the cache line out until the session reported cache activity", () => {
    const lines = render({ session: usage({ input: 1_000 }), lastRequest: usage({ input: 500 }) });

    expect(cacheLine(lines)).toBeUndefined();
    expect(lines).toContain("    ■ ■ ■ ■ ■ ■ ■ ■ ■ ■   Estimated usage by category");
  });

  it("paints the last turn in warning when it missed the cache the session had, and colours by hit rate", () => {
    const missed = render(
      { lastRequest: usage({ input: 1_000 }), session: usage({ input: 50, cacheRead: 50 }) },
      { width: 300 },
      tokenTheme,
    );
    const painted = render(
      { lastRequest: usage({ input: 80, cacheRead: 20 }), session: usage({ input: 10, cacheRead: 90 }) },
      { width: 300 },
      tokenTheme,
    );

    expect(cacheLine(missed)).toContain("Cache hit: last turn <warning>0%<dim> · session <warning>50%");
    expect(cacheLine(painted)).toContain("last turn <error>20%<dim> · session <success>90%");
  });

  it("shows only the session figure before any valid request on the branch", () => {
    expect(cacheLine(render({ lastRequest: undefined }))).toContain("Cache hit: session 91%");
  });

  it("marks an estimated total after compaction with ~ and · estimated", () => {
    const lines = render({ breakdown: breakdown({ total: null }) });

    expect(lines.some((line) => line.endsWith("Test Model · ~61.2k/200k tokens (31%) · estimated"))).toBe(
      true,
    );
    expect(lines).toContain("                          ■ Messages: 42.8k tokens (21.4%)");
  });

  it("warns on a full window and errors once the context exceeds it", () => {
    const lines = render({ breakdown: breakdown({ total: 210_000 }) }, { width: 300 }, tokenTheme);

    expect(lines.some((line) => line.endsWith("<muted>· <warning>Free space: 0 (0%)"))).toBe(true);
    expect(lines).toContain("    <error>Context exceeds the window by 10.0k tokens · /compact");
  });

  it("puts the legend under the grid when it does not fit beside it", () => {
    const at66 = render({}, { width: 66 });

    expect(at66[1]).toBe("    ■ ■ ■ ■ ■ ■ ■ ■ ■ ■");
    expect(at66).toContain("    Test Model · 61.2k/200k tokens (31%)");
    expect(render({}, { width: 67 })[1]).toBe(
      "    ■ ■ ■ ■ ■ ■ ■ ■ ■ ■   Test Model · 61.2k/200k tokens (31%)",
    );
  });

  it("uses 20 columns for windows of 1M only when the legend fits beside them", () => {
    const wide = (width: number) => render({ breakdown: breakdown({ window: 1_000_000 }) }, { width })[1];

    expect(wide(87)).toMatch(/^ {4}(\S ){19}\S {3}Test Model · 61\.2k\/1M tokens \(6%\)$/);
    expect(wide(86)).toMatch(/^ {4}(\S ){9}\S {3}Test Model · 61\.2k\/1M tokens \(6%\)$/);
    expect(wide(66)).toMatch(/^ {4}(\S ){9}\S$/);
    expect(render({}, { width: 120 })[1]).toMatch(/^ {4}(\S ){9}\S {3}Test Model/);
  });

  it.each([60, 72, 80, 100, 120])(
    "fits a long model name at %i columns without cutting the legend",
    (width) => {
      const long = breakdown({ model: "Long Model Name Preview Edition 1" });
      const intact = (lines: string[], texts: string[]) =>
        texts.filter((text) => !lines.some((line) => line.endsWith(` ${text}`)));
      const lines = render({ breakdown: long }, { width });
      const wide = render({ breakdown: { ...long, window: 1_000_000 } }, { width });
      const header =
        width < 64
          ? "Long Model Name Preview Edition 1 · 61.2k/200k (31%)"
          : "Long Model Name Preview Edition 1 · 61.2k/200k tokens (31%)";

      expect(
        intact(lines, [
          header,
          "■ Extension tools: 2.6k tokens (1.3%)",
          "░ Compaction reserve: 16.4k tokens (8.2%)",
        ]),
      ).toEqual([]);
      expect(
        intact(wide, [
          "Long Model Name Preview Edition 1 · 61.2k/1M tokens (6%)",
          "░ Compaction reserve: 16.4k tokens (1.6%)",
        ]),
      ).toEqual([]);
    },
  );

  it("keeps every line within the width", () => {
    [1, 5, 12, 39, 60, 79].forEach((width) => {
      render({}, { width }).forEach((line) => {
        expect(plainTheme.width(line)).toBeLessThanOrEqual(width);
      });
    });
  });

  it("summarises the snapshot in one line for modes without a transcript", () => {
    expect(summaryLine(snapshot())).toBe(
      "Context: Test Model · 61.2k/200k tokens (31%) · Cache hit: last turn 87% · session 91%",
    );
  });
});
