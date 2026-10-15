import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { plainTheme } from "../../../core/test/helpers/fakes.ts";
import { formatWindow, gridShape, renderSnapshot, summaryLine } from "../src/render.ts";
import { breakdown, snapshot, usage } from "./fixtures.ts";

const tokenTheme: ThemeLike = { ...plainTheme, fg: (token, text) => `<${token}>${text}` };

const render = (
  patch = {},
  options: Partial<{ width: number; expanded: boolean }> = {},
  theme = plainTheme,
) => renderSnapshot(theme, snapshot(patch), { width: 80, expanded: false, expandKey: "ctrl+o", ...options });

describe("renderSnapshot", () => {
  it("draws the grid beside the header, cache line and legend, then one summary per section", () => {
    expect(render()).toEqual([
      " Context Usage · 14:32",
      " ⛁ ⛁ ⛀ ⛁ ⛁ ⛀ ⛀ ⛁ ⛀ ⛁   Test Model · 61.2k/200k tokens (31%)",
      " ⛀ ⛀ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁   Cache hit: 87% last turn · 91% session",
      " ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁",
      " ⛁ ⛁ ⛁ ⛀ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   Estimated usage by category",
      " ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System prompt: 4.1k tokens (2.1%)",
      " ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System tools: 5.3k tokens (2.6%)",
      " ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ MCP tools: 1.8k tokens (0.9%)",
      " ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ Extension tools: 2.6k tokens (1.3%)",
      " ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ Memory files: 3.2k tokens (1.6%)",
      " ⛶ ⛶ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝   ⛁ Skills: 1.4k tokens (0.7%)",
      "                       ⛁ Messages: 42.8k tokens (21.4%)",
      "                       ⛶ Free space: 122.4k (61.2%)",
      "                       ⛝ Compaction reserve: 16.4k tokens (8.2%)",
      "",
      " Memory files · AGENTS.md",
      " └ 2 files · 3.2k tokens",
      " Skills · /skill:<name>",
      " └ 2 skills · 1.4k tokens",
      " MCP tools · /mcp",
      " └ 2 tools · 1.8k tokens · 1 loaded on demand",
      " Extension tools",
      " └ 1 tool · 2.6k tokens",
      " Messages",
      " └ 38 messages · tool results 31.0k · assistant 7.9k · user 2.1k · thinking 1.8k",
      " ctrl+o to expand",
    ]);
  });

  it("lists every item by tokens when expanded, system tools included", () => {
    const lines = render({}, { expanded: true });

    expect(lines.slice(lines.indexOf(" Memory files · AGENTS.md"))).toEqual([
      " Memory files · AGENTS.md",
      " └ ./AGENTS.md: 2.1k tokens",
      " └ ~/.pi/agent/AGENTS.md: 1.1k tokens",
      " Skills · /skill:<name>",
      " └ code-style: 900 tokens",
      " └ commits: 500 tokens",
      " MCP tools · /mcp",
      " └ search_docs: 1.8k tokens",
      " └ fetch_page: loaded on demand",
      " Extension tools",
      " └ run_agent: 2.6k tokens",
      " System tools",
      " └ read: 3.1k tokens",
      " └ bash: 1.2k tokens",
      " └ edit: 980 tokens",
      " Messages",
      " └ tool results: 31.0k tokens",
      " └ assistant: 7.9k tokens",
      " └ user: 2.1k tokens",
      " └ thinking: 1.8k tokens",
      " ctrl+o to collapse",
    ]);
  });

  it("expands without a toggle hint for /context all", () => {
    const lines = render({ expandedByDefault: true });

    expect(lines).toContain(" └ commits: 500 tokens");
    expect(lines.some((line) => line.includes("to expand") || line.includes("to collapse"))).toBe(false);
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
    expect(lines).toContain(" Messages");
  });

  it("leaves the cache line out until the session reported cache activity", () => {
    const lines = render({ session: usage(1_000, 0), lastRequest: usage(500, 0) });

    expect(lines[2]).toBe(" ⛀ ⛀ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁");
    expect(lines[3]).toBe(" ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁   Estimated usage by category");
  });

  it("paints the last turn in warning when it missed the cache the session had, and colours by hit rate", () => {
    const lines = render(
      { lastRequest: usage(1_000, 0), session: usage(50, 50) },
      { width: 300 },
      tokenTheme,
    );

    expect(lines[2]).toContain("Cache hit: <warning>0% last turn<dim> · <warning>50% session");
    expect(
      render({ lastRequest: usage(80, 20), session: usage(10, 90) }, { width: 300 }, tokenTheme)[2],
    ).toContain("<error>20% last turn<dim> · <success>90% session");
  });

  it("shows only the session figure before any valid request on the branch", () => {
    expect(render({ lastRequest: undefined })[2]).toContain("Cache hit: 91% session");
  });

  it("colours each category from the theme", () => {
    const lines = render({}, { width: 300 }, tokenTheme).join("\n");

    expect(
      [
        "<syntaxComment>⛁ System prompt",
        "<syntaxType>⛁ System tools",
        "<syntaxFunction>⛁ MCP tools",
        "<syntaxKeyword>⛁ Extension tools",
        "<syntaxString>⛁ Memory files",
        "<syntaxNumber>⛁ Skills",
        "<accent>⛁ Messages",
        "<dim>⛶ Free space",
        "<warning>⛝ Compaction reserve",
        "<text>Test Model",
      ].filter((text) => !lines.includes(text)),
    ).toEqual([]);
  });

  it("marks an estimated total after compaction with ~ and · estimated", () => {
    const lines = render({ breakdown: breakdown({ total: null }) });

    expect(lines[1]).toContain("Test Model · ~61.2k/200k tokens (31%) · estimated");
    expect(lines).toContain("                       ⛁ Messages: 42.8k tokens (21.4%)");
  });

  it("warns on a full window and errors once the context exceeds it", () => {
    const lines = render({ breakdown: breakdown({ total: 210_000 }) }, { width: 300 }, tokenTheme);

    expect(lines.some((line) => line.endsWith("<dim>⛶ <warning>Free space: 0 (0%)"))).toBe(true);
    expect(lines).toContain(" <error>Context exceeds the window by 10.0k tokens · /compact");
  });

  it("puts the legend under the grid below 60 columns and uses a 5 x 5 grid below 50", () => {
    const lines = render({}, { width: 45 });

    expect(lines.slice(1, 9)).toEqual([
      " ⛀ ⛀ ⛀ ⛀ ⛀",
      " ⛀ ⛁ ⛁ ⛁ ⛁",
      " ⛁ ⛀ ⛶ ⛶ ⛶",
      " ⛶ ⛶ ⛶ ⛶ ⛶",
      " ⛶ ⛶ ⛶ ⛝ ⛝",
      "",
      " Test Model · 61.2k/200k tokens (31%)",
      " Cache hit: 87% last turn · 91% session",
    ]);
    expect(lines.every((line) => plainTheme.width(line) <= 45)).toBe(true);
    expect(render({}, { width: 55 })[1]).toBe(" ⛁ ⛁ ⛀ ⛁ ⛁ ⛀ ⛀ ⛁ ⛀ ⛁");
  });

  it("uses 20 columns for windows of 1M from 72 columns on", () => {
    expect(gridShape(1_000_000, 80)).toEqual({ columns: 20, rows: 10 });
    expect(gridShape(1_000_000, 71)).toEqual({ columns: 10, rows: 10 });
    expect(gridShape(200_000, 120)).toEqual({ columns: 10, rows: 10 });
    expect(gridShape(1_000_000, 49)).toEqual({ columns: 5, rows: 5 });

    const wide = render({ breakdown: breakdown({ window: 1_000_000 }) }, { width: 100 });

    expect(wide[1]).toMatch(/^ (\S ){19}\S {3}Test Model · 61\.2k\/1M tokens \(6%\)$/);
  });

  it("cuts every line to the width", () => {
    expect(render({}, { width: 62 }).every((line) => plainTheme.width(line) <= 62)).toBe(true);
  });

  it("formats windows as whole k or M when they are round", () => {
    expect([200_000, 1_000_000, 1_048_576, 128_500, 900].map(formatWindow)).toEqual([
      "200k",
      "1M",
      "1.0M",
      "128.5k",
      "900",
    ]);
  });

  it("summarises the snapshot in one line for modes without a transcript", () => {
    expect(summaryLine(snapshot())).toBe(
      "Context: Test Model · 61.2k/200k tokens (31%) · Cache hit: 87% last turn · 91% session",
    );
  });
});
