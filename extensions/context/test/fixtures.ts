import type { ContextBreakdown, RequestUsage } from "../../../core/adapter/contract.ts";
import type { Snapshot } from "../src/breakdown.ts";

export const breakdown = (patch: Partial<ContextBreakdown> = {}): ContextBreakdown => ({
  model: "Test Model",
  window: 200_000,
  total: 61_200,
  reserve: 16_384,
  systemPrompt: 4_100,
  memoryFiles: [
    { name: "~/.pi/agent/AGENTS.md", tokens: 1_100 },
    { name: "./AGENTS.md", tokens: 2_100 },
  ],
  skills: [
    { name: "code-style", tokens: 900 },
    { name: "commits", tokens: 500 },
  ],
  tools: {
    builtin: [
      { name: "bash", tokens: 1_200 },
      { name: "edit", tokens: 980 },
      { name: "read", tokens: 3_120 },
    ],
    mcp: [
      { name: "search_docs", tokens: 1_800 },
      { name: "fetch_page", tokens: 0 },
    ],
    extension: [{ name: "run_agent", tokens: 2_600 }],
  },
  messages: {
    count: 38,
    user: 2_100,
    assistant: 7_900,
    thinking: 1_800,
    toolCalls: 0,
    toolResults: 31_000,
    other: 0,
  },
  ...patch,
});

export const usage = (input: number, cacheRead: number, cacheWrite = 0): RequestUsage => ({
  input,
  cacheRead,
  cacheWrite,
  output: 10,
});

export const STAMP = new Date(2026, 0, 2, 14, 32).getTime();

export const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => ({
  breakdown: breakdown(),
  lastRequest: usage(130, 870),
  session: usage(90, 910),
  timestamp: STAMP,
  expandedByDefault: false,
  ...patch,
});
