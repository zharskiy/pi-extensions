import { describe, expect, it } from "vitest";
import { createFakeHost, usageOf } from "../../../core/test/helpers/fakes.ts";
import { USAGE_ENTRY } from "../src/ledger.ts";
import { createSpending, STATUS_KEY, USAGE_CHANNEL } from "../src/spending.ts";

const setup = (subscription = false) => {
  const host = createFakeHost({ id: "main-session", subscription });

  createSpending(host);
  host.start();

  const report = (source: string, id: string, cost: number) => {
    host.emit(USAGE_CHANNEL, { source, id, usage: usageOf(cost) });
  };

  const usageEntries = () => host.entries.filter((entry) => entry.customType === USAGE_ENTRY);

  return { host, report, usageEntries };
};

describe("spending", () => {
  it("stays hidden until a source reports spend", () => {
    const { host, report } = setup();

    host.usage = usageOf(1);
    host.settle();

    expect(host.statuses.get(STATUS_KEY)).toBeUndefined();

    report("agents", "a1", 0);

    expect(host.statuses.get(STATUS_KEY)).toBeUndefined();
  });

  it("adds every reported id to pi's main session total", () => {
    const { host, report } = setup();

    host.usage = usageOf(1);
    report("agents", "a1", 0.1);
    report("agents", "a2", 0.2);
    report("agents", "a1", 0.05);

    expect(host.statuses.get(STATUS_KEY)).toBe("main $1.000 · agents $0.300 · total $1.300");
  });

  it("lists each source and marks subscription sessions", () => {
    const { host, report } = setup(true);

    report("jobs", "j1", 0.25);
    report("agents", "a1", 0.5);

    expect(host.statuses.get(STATUS_KEY)).toBe(
      "main $0.000 · agents $0.500 · jobs $0.250 · total $0.750 (sub)",
    );
  });

  it("ignores malformed payloads", () => {
    const { host } = setup();

    host.emit(USAGE_CHANNEL, { source: "agents", id: "a1", usage: { cost: 1 } });
    host.emit(USAGE_CHANNEL, null);
    host.settle();

    expect(host.statuses.get(STATUS_KEY)).toBeUndefined();
    expect(host.entries).toEqual([]);
  });

  it("refreshes main on idle", () => {
    const { host, report } = setup();

    report("agents", "a1", 0.1);
    host.usage = usageOf(2);
    host.settle();

    expect(host.statuses.get(STATUS_KEY)).toBe("main $2.000 · agents $0.100 · total $2.100");
  });

  it("persists changed figures on idle, not on every event", () => {
    const { host, report, usageEntries } = setup();

    report("agents", "a1", 0.1);
    report("agents", "a1", 0.2);

    expect(usageEntries()).toEqual([]);

    host.settle();
    host.settle();

    expect(usageEntries().map((entry) => entry.data)).toEqual([
      { source: "agents", id: "a1", usage: usageOf(0.2) },
    ]);
  });

  it("persists everything known at shutdown and drops reports that arrive after it", async () => {
    const { host, report, usageEntries } = setup();

    report("agents", "a1", 0.1);
    report("agents", "a2", 0.2);
    await host.shutdown();
    report("agents", "a1", 0.4);

    expect(
      usageEntries().map((entry) => (entry.data as { usage: { cost: { total: number } } }).usage.cost.total),
    ).toEqual([0.1, 0.2]);
  });

  it("shows the same totals in a resumed session and clears state on session start", () => {
    const { host, report } = setup();

    report("agents", "a1", 0.3);
    host.settle();

    const resumed = createFakeHost({ id: "main-session" });

    resumed.entries.push(...host.entries);
    createSpending(resumed);
    resumed.start();

    expect(resumed.statuses.get(STATUS_KEY)).toBe("main $0.000 · agents $0.300 · total $0.300");

    resumed.entries.splice(0);
    resumed.start();

    expect(resumed.statuses.get(STATUS_KEY)).toBeUndefined();
  });
});
