import { describe, expect, it } from "vitest";
import { usageOf } from "../../../core/test/helpers/fakes.ts";
import { createLedger, isAhead, parseUsageReport, USAGE_ENTRY } from "../src/ledger.ts";

const createStore = () => {
  const entries: { customType: string; data: unknown }[] = [];

  return {
    entries,
    append: (customType: string, data: unknown) => {
      entries.push({ customType, data: structuredClone(data) });
    },
    read: <T>(customType: string) =>
      entries.filter((entry) => entry.customType === customType).map((entry) => entry.data as T),
  };
};

const costs = (ledger: ReturnType<typeof createLedger>) =>
  ledger.totals().map(({ source, usage }) => [source, Number(usage.cost.total.toFixed(6))]);

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

describe("isAhead", () => {
  it("is ahead when cost or tokens grew", () => {
    expect(isAhead(usageOf(0.1), undefined)).toBe(true);
    expect(isAhead(usageOf(0.2), usageOf(0.1))).toBe(true);
    expect(isAhead(usageOf(0.1, 200), usageOf(0.1, 100))).toBe(true);
    expect(isAhead(usageOf(0.1), usageOf(0.1))).toBe(false);
    expect(isAhead(usageOf(0.05), usageOf(0.1))).toBe(false);
  });
});

describe("ledger", () => {
  it("keeps the highest figure per id and sums ids per source", () => {
    const ledger = createLedger(createStore());

    expect(ledger.record({ source: "agents", id: "a1", usage: usageOf(0.1) })).toBe(true);
    expect(ledger.record({ source: "agents", id: "a1", usage: usageOf(0.05) })).toBe(false);
    expect(ledger.record({ source: "agents", id: "a1", usage: usageOf(0.1) })).toBe(false);
    ledger.record({ source: "agents", id: "a2", usage: usageOf(0.2) });
    ledger.record({ source: "jobs", id: "a1", usage: usageOf(0.4) });

    expect(costs(ledger)).toEqual([
      ["agents", 0.3],
      ["jobs", 0.4],
    ]);
  });

  it("persists only figures that changed since the last persist", () => {
    const store = createStore();
    const ledger = createLedger(store);

    ledger.record({ source: "agents", id: "a1", usage: usageOf(0.1) });
    ledger.record({ source: "agents", id: "a2", usage: usageOf(0.2) });

    expect(ledger.persist()).toBe(2);
    expect(ledger.persist()).toBe(0);

    ledger.record({ source: "agents", id: "a2", usage: usageOf(0.3) });

    expect(ledger.persist()).toBe(1);
    expect(store.entries.map((entry) => entry.customType)).toEqual([USAGE_ENTRY, USAGE_ENTRY, USAGE_ENTRY]);
    expect(store.entries.at(-1)?.data).toEqual({ source: "agents", id: "a2", usage: usageOf(0.3) });
  });

  it("restores the highest persisted figure per id without persisting it again", () => {
    const store = createStore();
    const first = createLedger(store);

    first.record({ source: "agents", id: "a1", usage: usageOf(0.1) });
    first.persist();
    first.record({ source: "agents", id: "a1", usage: usageOf(0.3) });
    first.persist();
    store.append(USAGE_ENTRY, { source: "agents", id: "broken" });

    const second = createLedger(store);

    second.restore();

    expect(costs(second)).toEqual([["agents", 0.3]]);
    expect(second.persist()).toBe(0);
  });

  it("forgets everything on clear", () => {
    const ledger = createLedger(createStore());

    ledger.record({ source: "agents", id: "a1", usage: usageOf(0.1) });
    ledger.clear();

    expect(ledger.totals()).toEqual([]);
    expect(ledger.persist()).toBe(0);
  });
});
