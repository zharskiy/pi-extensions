import { describe, expect, it } from "vitest";
import { plainTheme } from "../../../../core/test/helpers/fakes.ts";
import { agentRow, finishSummary, progressText, treeRow, truncate } from "../../src/components/legacy-row.ts";
import type { AgentRecord } from "../../src/model/types.ts";

const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "explorer-1a2b",
  agent: "explorer",
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
  contextLimit: 100_000,
  handoffRequested: false,
  version: 0,
  ...patch,
});

describe("agent row formatting", () => {
  it("summarises a finished agent in one line", () => {
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
    expect(agentRow(record({ model: "acme/model-a:low" }), 45_000, 0, plainTheme, 120)).toBe(
      "⠋ explorer-1a2b (acme/model-a:low) · find the auth handler · 12 tool calls · 86.4k tokens · 45s · 20% ctx",
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

  it("indents nested agents and shows the grace countdown", () => {
    expect(
      treeRow(record({ depth: 3, state: "grace", graceEndsAt: 50_000 }), 45_000, 0, plainTheme, 140),
    ).toBe(
      "  ◐ explorer-1a2b · find the auth handler · 12 tool calls · 86.4k tokens · 45s · 20% ctx · stopping in 5s",
    );
  });
});
