import { describe, expect, it } from "vitest";
import { usageTotals } from "../../../test-framework/index.ts";
import { createLedger, USAGE_ENTRY } from "../core/ledger.ts";

const createStore = () => {
  const entries: { customType: string; data: unknown }[] = [];

  const append = (customType: string, data: unknown) => {
    entries.push({ customType, data: structuredClone(data) });
  };

  return { entries, append, data: () => entries.map((entry) => entry.data) };
};

const costs = (ledger: ReturnType<typeof createLedger>) =>
  ledger.totals().map(({ source, usage }) => [source, Number(usage.cost.total.toFixed(6))]);

describe("ledger", () => {
  it("keeps the highest figure per id and sums ids per source", () => {
    const ledger = createLedger(createStore().append);

    expect(ledger.record({ source: "agents", id: "a1", usage: usageTotals(0.1) })).toBe(true);
    expect(ledger.record({ source: "agents", id: "a1", usage: usageTotals(0.05) })).toBe(false);
    expect(ledger.record({ source: "agents", id: "a1", usage: usageTotals(0.1) })).toBe(false);
    ledger.record({ source: "agents", id: "a2", usage: usageTotals(0.2) });
    ledger.record({ source: "jobs", id: "a1", usage: usageTotals(0.4) });

    expect(costs(ledger)).toEqual([
      ["agents", 0.3],
      ["jobs", 0.4],
    ]);
  });

  it("persists only figures that changed since the last persist", () => {
    const store = createStore();
    const ledger = createLedger(store.append);

    ledger.record({ source: "agents", id: "a1", usage: usageTotals(0.1) });
    ledger.record({ source: "agents", id: "a2", usage: usageTotals(0.2) });

    expect(ledger.persist()).toBe(2);
    expect(ledger.persist()).toBe(0);

    ledger.record({ source: "agents", id: "a2", usage: usageTotals(0.3) });

    expect(ledger.persist()).toBe(1);
    expect(store.entries.map((entry) => entry.customType)).toEqual([USAGE_ENTRY, USAGE_ENTRY, USAGE_ENTRY]);
    expect(store.entries.at(-1)?.data).toEqual({ source: "agents", id: "a2", usage: usageTotals(0.3) });
  });

  it("restores the highest persisted figure per id without persisting it again", () => {
    const store = createStore();
    const first = createLedger(store.append);

    first.record({ source: "agents", id: "a1", usage: usageTotals(0.1) });
    first.persist();
    first.record({ source: "agents", id: "a1", usage: usageTotals(0.3) });
    first.persist();
    store.append(USAGE_ENTRY, { source: "agents", id: "broken" });

    const second = createLedger(store.append);

    second.restore(store.data());

    expect(costs(second)).toEqual([["agents", 0.3]]);
    expect(second.persist()).toBe(0);
  });

  it("persists absorbed figures it has not persisted yet", () => {
    const store = createStore();
    const ledger = createLedger(store.append);

    ledger.restore([{ source: "agents", id: "a1", usage: usageTotals(0.1) }]);
    ledger.absorb([
      { source: "agents", id: "a1", usage: usageTotals(0.1) },
      { source: "agents", id: "a2", usage: usageTotals(0.2) },
    ]);

    expect(ledger.persist()).toBe(1);
    expect(store.data()).toEqual([{ source: "agents", id: "a2", usage: usageTotals(0.2) }]);
  });

  it("keeps a figure only when neither cost nor tokens go down", () => {
    const ledger = createLedger(createStore().append);

    ledger.record({ source: "agents", id: "a1", usage: usageTotals(0.5, 100) });

    expect(ledger.record({ source: "agents", id: "a1", usage: usageTotals(0.1, 200) })).toBe(false);
    expect(ledger.record({ source: "agents", id: "a1", usage: usageTotals(0.6, 50) })).toBe(false);
    expect(costs(ledger)).toEqual([["agents", 0.5]]);
    expect(ledger.record({ source: "agents", id: "a1", usage: usageTotals(0.5, 200) })).toBe(true);
  });

  it("treats only the continuation source's marker as a continuation", () => {
    const ledger = createLedger(createStore().append);

    ledger.absorb([
      { source: "agents", id: "a1", usage: usageTotals(0.1) },
      { source: "agents", id: "continuation", usage: usageTotals(0.2) },
    ]);

    expect(costs(ledger)).toEqual([["agents", 0.3]]);
  });
});
