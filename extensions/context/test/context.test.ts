import { describe, expect, it } from "vitest";
import { createFakeHost } from "../../../core/test/helpers/fakes.ts";
import type { SessionInfo } from "../../../pi-adapter/index.ts";
import { createContext, SNAPSHOT_ENTRY } from "../src/context.ts";
import { facts, STAMP, snapshot, usage } from "./fixtures.ts";

const setup = (info: Partial<SessionInfo> = {}) => {
  const host = createFakeHost({ cwd: "/home/me/work", ...info });

  createContext(host, { home: "/home/me", now: () => STAMP });
  host.facts = facts();
  host.lastUsage = usage({ input: 130, cacheRead: 870 });
  host.mainUsage = usage({ input: 90, cacheRead: 910 });
  host.start();

  return host;
};

const stored = (host: ReturnType<typeof setup>, options: { expanded?: boolean } = {}) =>
  host.renderEntry(SNAPSHOT_ENTRY, host.entries[0]?.data, { width: 120, ...options });

describe("/context", () => {
  it("appends a frozen snapshot that renders from its own figures", async () => {
    const host = setup();

    await host.runCommand("context");
    host.mainUsage = usage({ input: 1 });
    host.facts = facts({ total: 1 });

    const lines = stored(host);

    expect(host.entries.map((entry) => entry.customType)).toEqual([SNAPSHOT_ENTRY]);
    expect(lines[0]).toBe("» Context usage · 14:32");
    expect(lines).toContain("    ■ ■ ■ ■ ■ ■ ■ ■ ■ ■   Cache hit: last turn 87% · session 91%");
    expect(lines.some((line) => line.endsWith("Test Model · 61.2k/200k tokens (31%)"))).toBe(true);
    expect(lines.at(-1)).toBe("    ... (14 more items, <app.tools.expand> to expand)");
  });

  it("buckets pi's facts into sections with short paths, listing every item when expanded", async () => {
    const host = setup();

    await host.runCommand("context");

    const lines = stored(host, { expanded: true });

    expect(lines.slice(lines.indexOf("    Memory files · AGENTS.md"))).toEqual([
      "    Memory files · AGENTS.md",
      "    ↳ ./AGENTS.md: 2.1k tokens",
      "      ~/.pi/agent/AGENTS.md: 1.1k tokens",
      "    Skills · /skill:<name>",
      "    ↳ code & style: 900 tokens",
      "      commits: 500 tokens",
      "    MCP tools · /mcp",
      "    ↳ search_docs: 1.8k tokens",
      "      fetch_page: loaded on demand",
      "    Extension tools",
      "    ↳ run_agent: 2.6k tokens",
      "    System tools",
      "    ↳ read: 3.0k tokens",
      "    Messages",
      "    ↳ tool results: 31.0k tokens",
      "      assistant: 7.0k tokens",
      "      user: 2.1k tokens",
      "      thinking: 1.8k tokens",
      "      tool calls: 900 tokens",
      "      other: 40 tokens",
    ]);
    expect(lines.some((line) => line.endsWith("■ System prompt: 1.0k tokens (0.5%)"))).toBe(true);
  });

  it("counts the messages and the tools loaded on demand in the collapsed summaries", async () => {
    const host = setup();

    await host.runCommand("context");

    const lines = stored(host);

    expect(lines).toContain("    ↳ 2 tools · 1.8k tokens · 1 loaded on demand");
    expect(lines).toContain("    ↳ 1 tool · 2.6k tokens");
    expect(lines.find((line) => line.startsWith("    ↳ 4 messages"))).toBe(
      "    ↳ 4 messages · tool results 31.0k · assistant 7.0k · user 2.1k · thinking 1.8k · tool calls 900 · other 40",
    );
  });

  it("stores all as expanded by default, without a toggle hint, and completes it", async () => {
    const host = setup();
    const spec = host.commands.get("context");

    await host.runCommand("context", "  all ");

    const lines = stored(host);

    expect(lines).toContain("      commits: 500 tokens");
    expect(lines.some((line) => line.includes("expand)") || line.includes("collapse)"))).toBe(false);
    expect(spec?.complete?.("a")).toEqual([{ value: "all", label: "all" }]);
    expect(spec?.complete?.("x")).toBeNull();
  });

  it("notifies a one-line summary instead of an entry outside tui mode", async () => {
    const host = setup({ mode: "rpc" });

    await host.runCommand("context");
    host.facts = facts({ total: null });
    await host.runCommand("context");

    expect(host.entries).toEqual([]);
    expect(host.notices.map((notice) => notice.message)).toEqual([
      "Context: Test Model · 61.2k/200k tokens (31%) · Cache hit: last turn 87% · session 91%",
      "Context: Test Model · ~55.8k/200k tokens (28%) · estimated · Cache hit: last turn 87% · session 91%",
    ]);
  });

  it("warns when there is nothing to measure", async () => {
    const host = setup();

    host.facts = undefined;
    await host.runCommand("context");

    expect(host.entries).toEqual([]);
    expect(host.notices).toEqual([{ message: "No live session to measure.", level: "warning" }]);
  });

  it("draws nothing for entries it cannot read", () => {
    const host = setup();
    const { total: _total, ...noTotal } = snapshot().breakdown;
    const { count: _count, ...noCount } = snapshot().breakdown.messages;

    expect(
      [
        { foreign: true },
        { ...snapshot(), breakdown: noTotal },
        { ...snapshot(), breakdown: { ...snapshot().breakdown, messages: noCount } },
        { ...snapshot(), breakdown: { ...snapshot().breakdown, model: 7 } },
        { ...snapshot(), session: { input: 1 } },
        "text",
      ].map((data) => host.renderEntry(SNAPSHOT_ENTRY, data)),
    ).toEqual([[], [], [], [], [], []]);
  });

  it("reads a stored snapshot with a null total and no last request", () => {
    const host = setup();
    const lines = host.renderEntry(SNAPSHOT_ENTRY, {
      ...snapshot({ breakdown: { ...snapshot().breakdown, total: null } }),
      lastRequest: null,
    });

    expect(lines.some((line) => line.includes("~61.2k/200k tokens (31%) · estimated"))).toBe(true);
    expect(lines.some((line) => line.includes("Cache hit: session 91%"))).toBe(true);
  });
});
