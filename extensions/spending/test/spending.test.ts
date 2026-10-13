import { describe, expect, it } from "vitest";
import { USAGE_CHANNEL } from "../../../core/manager/channels.ts";
import { createFakeHost, usageOf } from "../../../core/test/helpers/fakes.ts";
import { USAGE_ENTRY } from "../src/ledger.ts";
import { createSpending } from "../src/spending.ts";

const STATUS_KEY = "pi-spending";
const MAIN_OFFSET_ENTRY = "pi-spending:main-offset";

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

  it("shows the same totals in a resumed session", () => {
    const { host, report } = setup();

    report("agents", "a1", 0.3);
    host.settle();

    const resumed = createFakeHost({ id: "main-session" });

    resumed.entries.push(...host.entries);
    createSpending(resumed);
    resumed.start();

    expect(resumed.statuses.get(STATUS_KEY)).toBe("main $0.000 · agents $0.300 · total $0.300");
  });

  it("keeps the totals across a compaction", () => {
    const { host, report } = setup();

    host.usage = usageOf(1);
    report("agents", "a1", 0.3);
    host.compact();
    host.settle();

    expect(host.statuses.get(STATUS_KEY)).toBe("main $1.000 · agents $0.300 · total $1.300");
  });

  it("inherits the whole parent session's totals in a fork, also after resuming the fork", () => {
    const parent = {
      entries: [
        { customType: USAGE_ENTRY, data: { source: "agents", id: "a1", usage: usageOf(0.1) } },
        { customType: USAGE_ENTRY, data: { source: "agents", id: "a1", usage: usageOf(0.3) } },
        { customType: USAGE_ENTRY, data: { source: "agents", id: "a2", usage: usageOf(0.2) } },
      ],
      usage: usageOf(2),
    };

    const fork = createFakeHost();

    fork.files.set("/sessions/parent.jsonl", parent);
    fork.entries.push(structuredClone(parent.entries[0]));
    fork.usage = usageOf(0.5);
    createSpending(fork);
    fork.start("/sessions/parent.jsonl");

    expect(fork.statuses.get(STATUS_KEY)).toBe("main $2.000 · agents $0.500 · total $2.500");

    const resumed = createFakeHost();

    resumed.entries.push(...fork.entries);
    resumed.usage = usageOf(0.75);
    createSpending(resumed);
    resumed.start();

    expect(resumed.statuses.get(STATUS_KEY)).toBe("main $2.250 · agents $0.500 · total $2.750");
  });

  it("keeps the totals across a handoff switch (new session with a parent)", () => {
    const previous = {
      entries: [
        { customType: MAIN_OFFSET_ENTRY, data: 0.5 },
        { customType: USAGE_ENTRY, data: { source: "agents", id: "a1", usage: usageOf(0.4) } },
      ],
      usage: usageOf(1.5),
    };
    const next = createFakeHost();

    next.files.set("/sessions/previous.jsonl", previous);
    createSpending(next);
    next.start("/sessions/previous.jsonl");

    expect(next.statuses.get(STATUS_KEY)).toBe("main $2.000 · agents $0.400 · total $2.400");

    next.usage = usageOf(0.25);
    next.emit(USAGE_CHANNEL, { source: "agents", id: "a1", usage: usageOf(0.1) });

    expect(next.statuses.get(STATUS_KEY)).toBe("main $2.250 · agents $0.500 · total $2.750");
  });

  it("carries inherited totals into a fork of a fork", () => {
    const fork = { entries: [{ customType: MAIN_OFFSET_ENTRY, data: 1.5 }], usage: usageOf(0.75) };
    const grandchild = createFakeHost();

    grandchild.files.set("/sessions/fork.jsonl", fork);
    grandchild.entries.push(...structuredClone(fork.entries));
    grandchild.usage = usageOf(0.5);
    createSpending(grandchild);
    grandchild.start("/sessions/fork.jsonl");
    grandchild.emit(USAGE_CHANNEL, { source: "agents", id: "a3", usage: usageOf(0.1) });

    expect(grandchild.statuses.get(STATUS_KEY)).toBe("main $2.250 · agents $0.100 · total $2.350");
  });

  it("counts a new agent that draws the id of a parent agent, also after resuming the fork", () => {
    const parentEntry = {
      customType: USAGE_ENTRY,
      data: { source: "agents", id: "a1", usage: usageOf(0.5) },
    };
    const fork = createFakeHost();

    fork.files.set("/sessions/parent.jsonl", { entries: [parentEntry], usage: usageOf(0) });
    fork.entries.push(structuredClone(parentEntry));
    createSpending(fork);
    fork.start("/sessions/parent.jsonl");
    fork.emit(USAGE_CHANNEL, { source: "agents", id: "a1", usage: usageOf(0.1) });
    fork.settle();

    expect(fork.statuses.get(STATUS_KEY)).toBe("main $0.000 · agents $0.600 · total $0.600");

    const resumed = createFakeHost();

    resumed.entries.push(...fork.entries);
    createSpending(resumed);
    resumed.start();

    expect(resumed.statuses.get(STATUS_KEY)).toBe("main $0.000 · agents $0.600 · total $0.600");
  });
});
