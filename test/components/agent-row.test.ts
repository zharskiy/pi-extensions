import { describe, expect, it } from "vitest";
import {
  agentRow,
  finishSummary,
  formatElapsed,
  formatTokens,
  progressText,
  treeRow,
  truncate,
} from "../../src/components/agent-row.ts";
import type { AgentRecord } from "../../src/manager/types.ts";
import { plainTheme } from "../helpers/fakes.ts";

const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "explorer-1a2b",
  agent: "explorer",
  task: "find the auth handler",
  description: "find the auth handler",
  callerId: "main",
  depth: 2,
  batchId: "b-1",
  chainIndex: 1,
  state: "running",
  createdAt: 0,
  startedAt: 0,
  turns: 3,
  toolCalls: 12,
  tokens: 86_400,
  context: { tokens: 40_000, window: 200_000, percent: 20 },
  lastText: "",
  handoffPath: "/x/handoff.md",
  dir: "/x",
  budgetTokens: 100_000,
  handoffRequested: false,
  version: 0,
  ...patch,
});

describe("agent row formatting", () => {
  it("formats tokens and elapsed time compactly", () => {
    expect([formatTokens(950), formatTokens(86_400), formatTokens(1_250_000)]).toEqual([
      "950",
      "86.4k",
      "1.3M",
    ]);
    expect([formatElapsed(45_000), formatElapsed(73_000), formatElapsed(3_723_000)]).toEqual([
      "45s",
      "1m 13s",
      "1h 2m",
    ]);
  });

  it("summarises a finished agent like Claude Code does", () => {
    expect(finishSummary(record({ state: "done", endedAt: 73_000 }), 99_000)).toBe(
      "Done (12 tool calls · 86.4k tokens · 1m 13s)",
    );
    expect(finishSummary(record({ state: "failed", error: "rate limited", endedAt: 5_000 }), 9_000)).toBe(
      "Failed: rate limited (12 tool calls · 86.4k tokens · 5s)",
    );
  });

  it("shows live progress with context use while running", () => {
    expect(progressText(record(), 45_000)).toBe("12 tool calls · 86.4k tokens · 45s · 20% ctx");
    expect(progressText(record({ state: "queued" }), 1_000)).toBe("queued");
  });

  it("renders one line with icon, id, description and detail", () => {
    expect(agentRow(record(), 45_000, 0, plainTheme, 120)).toBe(
      "⠋ explorer-1a2b · find the auth handler · 12 tool calls · 86.4k tokens · 45s · 20% ctx",
    );
    expect(agentRow(record({ state: "done", endedAt: 73_000 }), 80_000, 0, plainTheme, 120)).toBe(
      "✓ explorer-1a2b · find the auth handler · Done (12 tool calls · 86.4k tokens · 1m 13s)",
    );
  });

  it("shows the model the agent runs on after its id", () => {
    expect(agentRow(record({ model: "openai/gpt-6-luna:low" }), 45_000, 0, plainTheme, 120)).toBe(
      "⠋ explorer-1a2b (openai/gpt-6-luna:low) · find the auth handler · 12 tool calls · 86.4k tokens · 45s · 20% ctx",
    );
  });

  it("truncates long descriptions to the width", () => {
    const line = agentRow(record({ description: "a".repeat(200) }), 45_000, 0, plainTheme, 80);

    expect(line).toContain("…");
    expect(line.length).toBeLessThanOrEqual(82);
    expect(truncate("abcdef", 4)).toBe("abc…");
  });

  it("shows the chain index after the id of a successor", () => {
    expect(agentRow(record({ chainIndex: 3 }), 45_000, 0, plainTheme, 120)).toBe(
      "⠋ explorer-1a2b #3 · find the auth handler · 12 tool calls · 86.4k tokens · 45s · 20% ctx",
    );
  });

  it("appends a pending question in warning colour while the agent waits for input", () => {
    const theme = { fg: (token: string, text: string) => `<${token}>${text}`, bold: (text: string) => text };
    const waiting = record({ attention: { kind: "confirm", title: "Allow bash?", since: 0 } });

    expect(agentRow(waiting, 45_000, 0, plainTheme, 120)).toBe(
      "⠋ explorer-1a2b · find the auth handler · 12 tool calls · 86.4k tokens · 45s · 20% ctx · needs input: Allow bash?",
    );
    expect(agentRow(waiting, 45_000, 0, theme as never, 120)).toMatch(
      /<warning> · needs input: Allow bash\?$/,
    );
    expect(agentRow({ ...waiting, state: "done", endedAt: 1_000 }, 45_000, 0, plainTheme, 120)).not.toContain(
      "needs input",
    );
  });

  it("indents nested agents and shows the grace countdown", () => {
    expect(
      treeRow(record({ depth: 3, state: "grace", graceEndsAt: 50_000 }), 45_000, 0, plainTheme, 140),
    ).toBe(
      "  ◐ explorer-1a2b · find the auth handler · 12 tool calls · 86.4k tokens · 45s · 20% ctx · stopping in 5s",
    );
  });
});
