import { describe, expect, it } from "vitest";
import { usageTotals } from "../../../test/framework/index.ts";
import {
  AWAITING_INPUT_CHANNEL,
  BUSY_CHANNEL,
  LIMITS_CHANNEL,
  parseAwaitingInput,
  parseBusySignal,
  parseLimits,
  parseTotals,
  parseUsageReport,
} from "../host-channels.ts";

describe("parseBusySignal", () => {
  it("names the channel pi:busy", () => {
    expect(BUSY_CHANNEL).toBe("pi:busy");
  });

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

describe("parseAwaitingInput", () => {
  it("names the channel pi:awaiting-input", () => {
    expect(AWAITING_INPUT_CHANNEL).toBe("pi:awaiting-input");
  });

  it("accepts a source, a waiting flag and an optional title", () => {
    expect(parseAwaitingInput({ source: "pi-questionnaire", waiting: true, title: "questionnaire" })).toEqual(
      {
        source: "pi-questionnaire",
        waiting: true,
        title: "questionnaire",
      },
    );
    expect(parseAwaitingInput({ source: "pi-questionnaire", waiting: false })).toEqual({
      source: "pi-questionnaire",
      waiting: false,
    });
    expect(parseAwaitingInput({ source: "x", waiting: true, title: "" })).toEqual({
      source: "x",
      waiting: true,
    });
  });

  it("ignores malformed payloads", () => {
    expect(parseAwaitingInput({ source: "", waiting: true })).toBeUndefined();
    expect(parseAwaitingInput({ source: "x", waiting: "yes" })).toBeUndefined();
    expect(parseAwaitingInput({ source: "x", waiting: true, title: 3 })).toBeUndefined();
    expect(parseAwaitingInput(null)).toBeUndefined();
  });
});

describe("parseUsageReport", () => {
  it("accepts a source, an id and complete usage totals", () => {
    const report = { source: "agents", id: "a1", usage: usageTotals(0.1) };

    expect(parseUsageReport(report)).toEqual(report);
  });

  it("ignores malformed payloads", () => {
    const { cost: _cost, ...withoutCost } = usageTotals(0.1);

    expect(parseUsageReport(undefined)).toBeUndefined();
    expect(parseUsageReport("agents")).toBeUndefined();
    expect(parseUsageReport({ source: "", id: "a1", usage: usageTotals(0.1) })).toBeUndefined();
    expect(parseUsageReport({ source: "agents", id: 7, usage: usageTotals(0.1) })).toBeUndefined();
    expect(parseUsageReport({ source: "agents", id: "a1", usage: withoutCost })).toBeUndefined();
    expect(parseUsageReport({ source: "agents", id: "a1", usage: usageTotals(-1) })).toBeUndefined();
    expect(
      parseUsageReport({
        source: "agents",
        id: "a1",
        usage: { ...usageTotals(0.1), totalTokens: Number.NaN },
      }),
    ).toBeUndefined();
  });
});

describe("parseTotals", () => {
  it("accepts main and per-source cost and tokens", () => {
    const totals = {
      main: { cost: 1, tokens: 10 },
      sources: [{ source: "agents", cost: 0.5, tokens: 5 }],
      subscription: false,
    };

    expect(parseTotals({ ...totals, extra: true })).toEqual(totals);
    expect(parseTotals({ main: { cost: 0, tokens: 0 }, sources: [], subscription: true })).toEqual({
      main: { cost: 0, tokens: 0 },
      sources: [],
      subscription: true,
    });
  });

  it("ignores malformed payloads", () => {
    expect(parseTotals(undefined)).toBeUndefined();
    expect(parseTotals({ main: { cost: 1 }, sources: [], subscription: false })).toBeUndefined();
    expect(parseTotals({ main: { cost: -1, tokens: 0 }, sources: [], subscription: false })).toBeUndefined();
    expect(parseTotals({ main: { cost: 1, tokens: 0 }, subscription: false })).toBeUndefined();
    expect(
      parseTotals({
        main: { cost: 1, tokens: 0 },
        sources: [{ source: "", cost: 1, tokens: 0 }],
        subscription: false,
      }),
    ).toBeUndefined();
    expect(
      parseTotals({ main: { cost: 1, tokens: 0 }, sources: [null], subscription: false }),
    ).toBeUndefined();
  });

  it("requires a boolean subscription flag", () => {
    const totals = { main: { cost: 1, tokens: 0 }, sources: [] };

    expect(parseTotals(totals)).toBeUndefined();
    expect(parseTotals({ ...totals, subscription: "yes" })).toBeUndefined();
    expect(parseTotals({ ...totals, subscription: 1 })).toBeUndefined();
  });
});

describe("parseLimits", () => {
  const limits = { softRatio: 0.45, hardRatio: 0.6, softTokens: 125_000, hardTokens: 175_000 };

  it("names the channel session-limits:limits", () => {
    expect(LIMITS_CHANNEL).toBe("session-limits:limits");
  });

  it("accepts the defaults and ratios up to 1", () => {
    expect(parseLimits({ ...limits, extra: true })).toEqual(limits);
    expect(parseLimits({ ...limits, hardRatio: 1 })).toEqual({ ...limits, hardRatio: 1 });
  });

  it("ignores malformed payloads", () => {
    expect(parseLimits(undefined)).toBeUndefined();
    expect(parseLimits({ ...limits, softRatio: undefined })).toBeUndefined();
    expect(parseLimits({ ...limits, softTokens: "125000" })).toBeUndefined();
    expect(parseLimits({ ...limits, softRatio: 0 })).toBeUndefined();
    expect(parseLimits({ ...limits, hardRatio: 1.1 })).toBeUndefined();
    expect(parseLimits({ ...limits, hardTokens: -1 })).toBeUndefined();
    expect(parseLimits({ ...limits, hardTokens: Number.NaN })).toBeUndefined();
  });
});
