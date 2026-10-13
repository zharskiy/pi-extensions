import { describe, expect, it } from "vitest";
import { parseBusySignal, parseTotals, parseUsageReport } from "../../manager/channels.ts";
import { usageOf } from "../helpers/fakes.ts";

describe("parseBusySignal", () => {
  it("accepts a source name and a busy flag only", () => {
    expect(parseBusySignal({ source: "pi-subagents", busy: true })).toEqual({
      source: "pi-subagents",
      busy: true,
    });
    expect(parseBusySignal({ source: "", busy: true })).toBeUndefined();
    expect(parseBusySignal({ source: "x", busy: "yes" })).toBeUndefined();
    expect(parseBusySignal(null)).toBeUndefined();
    expect(parseBusySignal("busy")).toBeUndefined();
  });
});

describe("parseUsageReport", () => {
  it("accepts a source, an id and complete usage totals", () => {
    const report = { source: "agents", id: "a1", usage: usageOf(0.1) };

    expect(parseUsageReport(report)).toEqual(report);
  });

  it("ignores malformed payloads", () => {
    const { cost: _cost, ...withoutCost } = usageOf(0.1);

    expect(parseUsageReport(undefined)).toBeUndefined();
    expect(parseUsageReport("agents")).toBeUndefined();
    expect(parseUsageReport({ source: "", id: "a1", usage: usageOf(0.1) })).toBeUndefined();
    expect(parseUsageReport({ source: "agents", id: 7, usage: usageOf(0.1) })).toBeUndefined();
    expect(parseUsageReport({ source: "agents", id: "a1", usage: withoutCost })).toBeUndefined();
    expect(parseUsageReport({ source: "agents", id: "a1", usage: usageOf(-1) })).toBeUndefined();
    expect(
      parseUsageReport({ source: "agents", id: "a1", usage: { ...usageOf(0.1), totalTokens: Number.NaN } }),
    ).toBeUndefined();
  });
});

describe("parseTotals", () => {
  it("accepts main and per-source cost and tokens", () => {
    const totals = { main: { cost: 1, tokens: 10 }, sources: [{ source: "agents", cost: 0.5, tokens: 5 }] };

    expect(parseTotals({ ...totals, extra: true })).toEqual(totals);
    expect(parseTotals({ main: { cost: 0, tokens: 0 }, sources: [] })).toEqual({
      main: { cost: 0, tokens: 0 },
      sources: [],
    });
  });

  it("ignores malformed payloads", () => {
    expect(parseTotals(undefined)).toBeUndefined();
    expect(parseTotals({ main: { cost: 1 }, sources: [] })).toBeUndefined();
    expect(parseTotals({ main: { cost: -1, tokens: 0 }, sources: [] })).toBeUndefined();
    expect(parseTotals({ main: { cost: 1, tokens: 0 } })).toBeUndefined();
    expect(
      parseTotals({ main: { cost: 1, tokens: 0 }, sources: [{ source: "", cost: 1, tokens: 0 }] }),
    ).toBeUndefined();
    expect(parseTotals({ main: { cost: 1, tokens: 0 }, sources: [null] })).toBeUndefined();
  });
});
