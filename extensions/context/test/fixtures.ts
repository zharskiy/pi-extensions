import type { ContextFacts, PromptTokens } from "../../../core/adapter/contract.ts";
import type { Breakdown } from "../src/buckets.ts";
import type { Snapshot } from "../src/snapshot.ts";

export const breakdown = (patch: Partial<Breakdown> = {}): Breakdown => ({
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

const sized = (head: string, tail: string, tokens: number) =>
  `${head}${"x".repeat(tokens * 4 - head.length - tail.length)}${tail}`;

const memoryFile = (path: string, tokens: number) =>
  sized(`<project_instructions path="${path}">\n`, "\n</project_instructions>", tokens);

const skill = (name: string, tokens: number) => sized(`<skill><name>${name}</name>`, "</skill>", tokens);

export const facts = (patch: Partial<ContextFacts> = {}): ContextFacts => ({
  model: "Test Model",
  window: 200_000,
  total: 61_200,
  reserve: 16_384,
  sections: [
    { name: "prompt", text: "p".repeat(4_000) },
    {
      name: "project_context",
      text: `${memoryFile("/home/me/work/AGENTS.md", 2_100)}${memoryFile("/home/me/.pi/agent/AGENTS.md", 1_100)}`,
    },
    { name: "skills", text: `${skill("code &amp; style", 900)}${skill("commits", 500)}` },
  ],
  tools: [
    { name: "read", source: "builtin", onDemand: false, chars: 12_000 },
    { name: "search_docs", source: "mcp", onDemand: false, chars: 7_200 },
    { name: "fetch_page", source: "mcp", onDemand: true, chars: 4_000 },
    { name: "run_agent", source: "extension", onDemand: false, chars: 10_400 },
    { name: "later", source: "extension", onDemand: true, chars: 400 },
  ],
  messages: [
    { role: "user", tokens: 2_100, blocks: [] },
    {
      role: "assistant",
      tokens: 9_700,
      blocks: [
        { type: "text", tokens: 7_000 },
        { type: "thinking", tokens: 1_800 },
        { type: "toolCall", tokens: 900 },
      ],
    },
    { role: "toolResult", tokens: 31_000, blocks: [] },
    { role: "custom", tokens: 40, blocks: [] },
  ],
  ...patch,
});

export const usage = ({ input = 0, cacheRead = 0, cacheWrite = 0 }: Partial<PromptTokens>): PromptTokens => ({
  input,
  cacheRead,
  cacheWrite,
  output: 10,
});

export const STAMP = new Date(2026, 0, 2, 14, 32).getTime();

export const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => ({
  breakdown: breakdown(),
  lastRequest: usage({ input: 130, cacheRead: 870 }),
  session: usage({ input: 90, cacheRead: 910 }),
  timestamp: STAMP,
  expandedByDefault: false,
  ...patch,
});
