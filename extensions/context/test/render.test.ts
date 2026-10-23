import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { renderSnapshot } from "../src/render.ts";
import { summaryLine } from "../src/summary.ts";
import { breakdown, snapshot, usage } from "./fixtures.ts";

const tokenTheme: ThemeLike = { ...plainTheme, fg: (token, text) => `<${token}>${text}` };

const cacheLine = (lines: string[]) => lines.find((line) => line.includes("Cache hit:"));

const render = (
  patch = {},
  options: Partial<{ width: number; expanded: boolean }> = {},
  theme = plainTheme,
) => renderSnapshot(theme, snapshot(patch), { width: 80, expanded: false, expandKey: "ctrl+o", ...options });

describe("renderSnapshot", () => {
  it("draws the grid beside the header, cache line and legend, then one summary per section", () => {
    expect(render()).toEqual([
      "● Context Usage · 14:32",
      "  ⛁ ⛁ ⛁ ⛁ ⛀ ⛀ ⛁ ⛁ ⛀ ⛁   Test Model · 61.2k/200k tokens (31%)",
      "  ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁   Cache hit: last turn 87% · session 91%",
      "  ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁",
      "  ⛀ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   Estimated usage by category",
      "  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System prompt: 4.1k tokens (2.1%)",
      "  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System tools: 5.3k tokens (2.6%)",
      "  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ MCP tools: 1.8k tokens (0.9%)",
      "  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ Extension tools: 2.6k tokens (1.3%)",
      "  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ Memory files: 3.2k tokens (1.6%)",
      "  ⛶ ⛶ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝   ⛁ Skills: 1.4k tokens (0.7%)",
      "                        ⛁ Messages: 42.8k tokens (21.4%)",
      "                        ⛶ Free space: 122.4k (61.2%)",
      "                        ⛝ Compaction reserve: 16.4k tokens (8.2%)",
      "",
      "  Memory files · AGENTS.md",
      "  └ 2 files · 3.2k tokens",
      "  Skills · /skill:<name>",
      "  └ 2 skills · 1.4k tokens",
      "  MCP tools · /mcp",
      "  └ 2 tools · 1.8k tokens · 1 loaded on demand",
      "  Extension tools",
      "  └ 1 tool · 2.6k tokens",
      "  Messages",
      "  └ 38 messages · tool results 31.0k · assistant 7.9k · user 2.1k · thinking 1.8k",
      "  (ctrl+o expand)",
    ]);
  });

  it("starts with a success bullet, the title and the dim time, and hangs the body two columns in", () => {
    const lines = render({}, {}, tokenTheme);

    expect(lines[0]).toBe("<success>● Context Usage<dim> · 14:32");
    expect(lines.slice(1).every((line) => line === "" || line.startsWith("  "))).toBe(true);
    expect(lines.at(-1)).toBe("  <dim>(ctrl+o expand)");
  });

  it("lists every item by tokens when expanded, system tools included", () => {
    const lines = render({}, { expanded: true });

    expect(lines.slice(lines.indexOf("  Memory files · AGENTS.md"))).toEqual([
      "  Memory files · AGENTS.md",
      "  └ ./AGENTS.md: 2.1k tokens",
      "  └ ~/.pi/agent/AGENTS.md: 1.1k tokens",
      "  Skills · /skill:<name>",
      "  └ code-style: 900 tokens",
      "  └ commits: 500 tokens",
      "  MCP tools · /mcp",
      "  └ search_docs: 1.8k tokens",
      "  └ fetch_page: loaded on demand",
      "  Extension tools",
      "  └ run_agent: 2.6k tokens",
      "  System tools",
      "  └ read: 3.1k tokens",
      "  └ bash: 1.2k tokens",
      "  └ edit: 980 tokens",
      "  Messages",
      "  └ tool results: 31.0k tokens",
      "  └ assistant: 7.9k tokens",
      "  └ user: 2.1k tokens",
      "  └ thinking: 1.8k tokens",
      "  (ctrl+o collapse)",
    ]);
  });

  it("expands without a toggle hint for /context all", () => {
    const lines = render({ expandedByDefault: true });

    expect(lines).toContain("  └ commits: 500 tokens");
    expect(lines.some((line) => line.includes("expand)") || line.includes("collapse)"))).toBe(false);
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
    expect(lines).toContain("  Messages");
  });

  it("leaves the cache line out until the session reported cache activity", () => {
    const lines = render({ session: usage({ input: 1_000 }), lastRequest: usage({ input: 500 }) });

    expect(cacheLine(lines)).toBeUndefined();
    expect(lines).toContain("  ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁   Estimated usage by category");
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

  it("colours each category from the theme", () => {
    const lines = render({}, { width: 300 }, tokenTheme).join("\n");

    expect(
      [
        "<comment>⛁ System prompt",
        "<type>⛁ System tools",
        "<function>⛁ MCP tools",
        "<keyword>⛁ Extension tools",
        "<string>⛁ Memory files",
        "<number>⛁ Skills",
        "<accent>⛁ Messages",
        "<dim>⛶ Free space",
        "<warning>⛝ Compaction reserve",
        "<text>Test Model",
      ].filter((text) => !lines.includes(text)),
    ).toEqual([]);
  });

  it("marks an estimated total after compaction with ~ and · estimated", () => {
    const lines = render({ breakdown: breakdown({ total: null }) });

    expect(lines.some((line) => line.endsWith("Test Model · ~61.2k/200k tokens (31%) · estimated"))).toBe(
      true,
    );
    expect(lines).toContain("                        ⛁ Messages: 42.8k tokens (21.4%)");
  });

  it("warns on a full window and errors once the context exceeds it", () => {
    const lines = render({ breakdown: breakdown({ total: 210_000 }) }, { width: 300 }, tokenTheme);

    expect(lines.some((line) => line.endsWith("<dim>⛶ <warning>Free space: 0 (0%)"))).toBe(true);
    expect(lines).toContain("  <error>Context exceeds the window by 10.0k tokens · /compact");
  });

  it("puts the legend under the grid when it does not fit beside it and uses a 5 x 5 grid below 50", () => {
    const lines = render({}, { width: 45 });
    const at64 = render({}, { width: 64 });

    expect(lines.slice(1, 9)).toEqual([
      "  ⛀ ⛀ ⛁ ⛁ ⛁",
      "  ⛁ ⛁ ⛀ ⛶ ⛶",
      "  ⛶ ⛶ ⛶ ⛶ ⛶",
      "  ⛶ ⛶ ⛶ ⛶ ⛶",
      "  ⛶ ⛶ ⛶ ⛝ ⛝",
      "",
      "  Test Model · 61.2k/200k tokens (31%)",
      "  Cache hit: last turn 87% · session 91%",
    ]);
    expect(at64[1]).toBe("  ⛁ ⛁ ⛁ ⛁ ⛀ ⛀ ⛁ ⛁ ⛀ ⛁");
    expect(at64).toContain("  Test Model · 61.2k/200k tokens (31%)");
    expect(render({}, { width: 65 })[1]).toBe("  ⛁ ⛁ ⛁ ⛁ ⛀ ⛀ ⛁ ⛁ ⛀ ⛁   Test Model · 61.2k/200k tokens (31%)");
  });

  it("uses 20 columns for windows of 1M only when the legend fits beside them", () => {
    const wide = (width: number) => render({ breakdown: breakdown({ window: 1_000_000 }) }, { width })[1];

    expect(wide(85)).toMatch(/^ {2}(\S ){19}\S {3}Test Model · 61\.2k\/1M tokens \(6%\)$/);
    expect(wide(84)).toMatch(/^ {2}(\S ){9}\S {3}Test Model · 61\.2k\/1M tokens \(6%\)$/);
    expect(wide(64)).toMatch(/^ {2}(\S ){9}\S$/);
    expect(render({}, { width: 120 })[1]).toMatch(/^ {2}(\S ){9}\S {3}Test Model/);
  });

  it.each([60, 72, 80, 100, 120])(
    "fits a long model name at %i columns without cutting the legend",
    (width) => {
      const long = breakdown({ model: "Long Model Name Preview Edition 1" });
      const intact = (lines: string[], texts: string[]) =>
        texts.filter((text) => !lines.some((line) => line.endsWith(` ${text}`)));
      const lines = render({ breakdown: long }, { width });
      const wide = render({ breakdown: { ...long, window: 1_000_000 } }, { width });

      expect(
        intact(lines, [
          "Long Model Name Preview Edition 1 · 61.2k/200k tokens (31%)",
          "⛁ Extension tools: 2.6k tokens (1.3%)",
          "⛝ Compaction reserve: 16.4k tokens (8.2%)",
        ]),
      ).toEqual([]);
      expect(
        intact(wide, [
          "Long Model Name Preview Edition 1 · 61.2k/1M tokens (6%)",
          "⛝ Compaction reserve: 16.4k tokens (1.6%)",
        ]),
      ).toEqual([]);
    },
  );

  it("stacks the header and legend under the grid at 80 columns when the header does not fit beside it", () => {
    const lines = render({ breakdown: breakdown({ model: "Long Model Name Preview Edition 1" }) });

    expect(lines.slice(1, 3)).toEqual(["  ⛁ ⛁ ⛁ ⛁ ⛀ ⛀ ⛁ ⛁ ⛀ ⛁", "  ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁"]);
    expect(lines).toContain("  Long Model Name Preview Edition 1 · 61.2k/200k tokens (31%)");
    expect(lines).toContain("  ⛝ Compaction reserve: 16.4k tokens (8.2%)");
  });

  it("summarises the snapshot in one line for modes without a transcript", () => {
    expect(summaryLine(snapshot())).toBe(
      "Context: Test Model · 61.2k/200k tokens (31%) · Cache hit: last turn 87% · session 91%",
    );
  });
});
