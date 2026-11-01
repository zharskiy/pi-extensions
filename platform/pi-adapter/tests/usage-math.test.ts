import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { contextOf, sumAssistantUsage, sumUsage } from "../context/usage-math.ts";

const usage = (total: number) => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const assistant = {
  role: "assistant" as const,
  content: [],
  api: "acme-api",
  provider: "acme",
  model: "model-a",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop" as const,
  timestamp: 0,
};

describe("usage", () => {
  it("sums assistant, tool result, usage, compaction and branch summary entries", () => {
    const totals = sumUsage([
      { type: "message", message: { role: "assistant", usage: usage(1) } },
      { type: "message", message: { role: "toolResult", usage: usage(2) } },
      { type: "message", message: { role: "user", usage: usage(100) } },
      { type: "usage", usage: usage(4) },
      { type: "compaction", usage: usage(8) },
      { type: "branch_summary", usage: usage(16) },
      { type: "custom" },
    ]);

    expect(totals.cost.total).toBe(31);
    expect(totals.totalTokens).toBe(10);
  });

  it("counts a usage entry without cost or token fields as zero instead of throwing", () => {
    const totals = sumUsage([
      { type: "message", message: { role: "assistant", usage: usage(1) } },
      { type: "message", message: { role: "assistant", usage: { input: 3, output: 2 } } },
      { type: "usage", usage: { cost: { total: 2 } } },
    ]);

    expect(totals).toEqual({
      input: 4,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
    });
  });

  it("sums only assistant messages for the request usage, leaving warm-ups, summaries and tool results out", () => {
    const request = (input: number) => ({ ...usage(0), input, cacheRead: input * 2, cacheWrite: 1 });

    expect(
      sumAssistantUsage([
        { type: "message", message: { role: "assistant", usage: request(1) } },
        { type: "message", message: { role: "assistant" } },
        { type: "message", message: { role: "toolResult", usage: request(100) } },
        { type: "usage", usage: request(1_000) },
        { type: "compaction", usage: request(1_000) },
        { type: "branch_summary", usage: request(1_000) },
        { type: "message", message: { role: "assistant", usage: request(10) } },
      ]),
    ).toEqual({ input: 11, cacheRead: 22, cacheWrite: 2, output: 2 });
  });

  it("keeps counting entries a compaction or a tree navigation leaves behind", () => {
    const session = SessionManager.inMemory("/tmp");
    const reply = (total: number) => ({
      ...assistant,
      usage: { ...assistant.usage, cost: { ...assistant.usage.cost, total } },
    });

    const first = session.appendMessage({ role: "user", content: "hi", timestamp: 0 });

    session.appendMessage(reply(1));
    session.appendCompaction("summary", first, 100, undefined, false, reply(2).usage);
    session.appendMessage(reply(4));
    session.branch(first);
    session.appendMessage(reply(8));

    expect(session.getBranch().length).toBe(2);
    expect(sumUsage(session.getEntries()).cost.total).toBe(15);
  });

  it("reports an unknown context when pi has no context usage", () => {
    expect(contextOf({ getContextUsage: () => undefined })).toEqual({
      tokens: null,
      window: 0,
      percent: null,
    });
  });
});
