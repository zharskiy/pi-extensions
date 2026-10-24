import { describe, expect, it } from "vitest";
import { runUsage, sessionEvents } from "../pi/live/index.ts";

const stats = (cost: number) => ({
  sessionFile: undefined,
  sessionId: "s1",
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 3,
  toolResults: 3,
  totalMessages: 5,
  tokens: { input: 120, output: 40, cacheRead: 0, cacheWrite: 0, total: 160 },
  cost,
});

const priced = (input: number, output: number) =>
  ({ cost: { input, output, cacheRead: 0, cacheWrite: 0 } }) as never;

describe("sessionEvents", () => {
  it("turns user, assistant and tool result messages into run events", () => {
    const events = sessionEvents([
      { role: "user", content: "Find the bug" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking" },
          { type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "bug" } },
        ],
      },
      { role: "toolResult", toolName: "grep", content: [{ type: "text", text: "a.ts:1" }], isError: false },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "a.ts" } }],
      },
    ]);

    expect(events).toEqual([
      { type: "message", role: "user", text: "Find the bug" },
      { type: "message", role: "assistant", text: "Looking" },
      { type: "tool_call", name: "grep", arguments: { pattern: "bug" } },
      { type: "tool_result", name: "grep", text: "a.ts:1", isError: false },
      { type: "tool_call", name: "read", arguments: { path: "a.ts" } },
    ]);
  });
});

describe("runUsage", () => {
  it("reads tokens, tool calls and cost from the session stats", () => {
    const usage = runUsage({ getSessionStats: () => stats(0.25), model: priced(1, 5) });

    expect(usage).toEqual({ inputTokens: 120, outputTokens: 40, toolCalls: 3, costUsd: 0.25 });
  });

  it("leaves the cost out when the model has no pricing", () => {
    const usage = runUsage({ getSessionStats: () => stats(0), model: priced(0, 0) });

    expect(usage).toEqual({ inputTokens: 120, outputTokens: 40, toolCalls: 3 });
  });
});
