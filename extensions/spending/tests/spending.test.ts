import { describe, expect, it } from "vitest";
import { parseTotals, TOTALS_CHANNEL, USAGE_CHANNEL } from "../../../platform/shared/index.ts";
import {
  createFakeAgentRuntime,
  createFakeHost,
  type FakeHost,
  usageTotals,
} from "../../../test/framework/index.ts";
import spending from "../api/extension.ts";
import { USAGE_ENTRY } from "../core/ledger.ts";

const STATUS_KEY = "pi-spending";
const MAIN_OFFSET_ENTRY = "pi-spending:main-offset";

const bootSpending = (host: FakeHost) => {
  spending.boot(host, createFakeAgentRuntime(), {
    root: spending.options.root,
    agentDir: host.info.agentDir,
  });
};

const setup = (subscription = false) => {
  const host = createFakeHost({ id: "main-session", subscription });

  bootSpending(host);
  host.start();

  const report = (source: string, id: string, cost: number) => {
    host.emit(USAGE_CHANNEL, { source, id, usage: usageTotals(cost) });
  };

  const usageEntries = () => host.entries.filter((entry) => entry.customType === USAGE_ENTRY);

  const lastTotals = () => host.published.filter((entry) => entry.channel === TOTALS_CHANNEL).at(-1)?.data;

  return { host, report, usageEntries, lastTotals };
};

describe("spending", () => {
  it("stays hidden until a source reports spend", () => {
    const { host, report } = setup();

    host.usage = usageTotals(1);
    host.settle();

    expect(host.statuses.get(STATUS_KEY)).toBeUndefined();

    report("agents", "a1", 0);

    expect(host.statuses.get(STATUS_KEY)).toBeUndefined();
  });

  it("adds every reported id to pi's main session total", () => {
    const { host, report } = setup();

    host.usage = usageTotals(1);
    report("agents", "a1", 0.1);
    report("agents", "a2", 0.2);
    report("agents", "a1", 0.05);

    expect(host.statuses.get(STATUS_KEY)).toBe("main $1.00 · agents $0.30 · total $1.30");
  });

  it("lists each source and marks subscription sessions", () => {
    const { host, report } = setup(true);

    report("jobs", "j1", 0.25);
    report("agents", "a1", 0.5);

    expect(host.statuses.get(STATUS_KEY)).toBe("main $0.00 · agents $0.50 · jobs $0.25 · total $0.75 (sub)");
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
    host.usage = usageTotals(2);
    host.settle();

    expect(host.statuses.get(STATUS_KEY)).toBe("main $2.00 · agents $0.10 · total $2.10");
  });

  it("persists changed figures on idle, not on every event while busy", () => {
    const { host, report, usageEntries } = setup();

    host.agentStart();
    report("agents", "a1", 0.1);
    report("agents", "a1", 0.2);

    expect(usageEntries()).toEqual([]);

    host.settle();
    host.settle();

    expect(usageEntries().map((entry) => entry.data)).toEqual([
      { source: "agents", id: "a1", usage: usageTotals(0.2) },
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
    bootSpending(resumed);
    resumed.start();

    expect(resumed.statuses.get(STATUS_KEY)).toBe("main $0.00 · agents $0.30 · total $0.30");
  });

  it("keeps the totals across a compaction", () => {
    const { host, report } = setup();

    host.usage = usageTotals(1);
    report("agents", "a1", 0.3);
    host.compact();
    host.settle();

    expect(host.statuses.get(STATUS_KEY)).toBe("main $1.00 · agents $0.30 · total $1.30");
  });

  it("inherits the whole parent session's totals in a fork, also after resuming the fork", () => {
    const parent = {
      entries: [
        { customType: USAGE_ENTRY, data: { source: "agents", id: "a1", usage: usageTotals(0.1) } },
        { customType: USAGE_ENTRY, data: { source: "agents", id: "a1", usage: usageTotals(0.3) } },
        { customType: USAGE_ENTRY, data: { source: "agents", id: "a2", usage: usageTotals(0.2) } },
      ],
      usage: usageTotals(2),
    };

    const fork = createFakeHost();

    fork.files.set("/sessions/parent.jsonl", parent);
    fork.entries.push(structuredClone(parent.entries[0]));
    fork.usage = usageTotals(0.5);
    bootSpending(fork);
    fork.start("/sessions/parent.jsonl");

    expect(fork.statuses.get(STATUS_KEY)).toBe("main $2.00 · agents $0.50 · total $2.50");

    const resumed = createFakeHost();

    resumed.entries.push(...fork.entries);
    resumed.usage = usageTotals(0.75);
    bootSpending(resumed);
    resumed.start();

    expect(resumed.statuses.get(STATUS_KEY)).toBe("main $2.25 · agents $0.50 · total $2.75");
  });

  it("keeps the totals across a handoff switch (new session with a parent)", () => {
    const previous = {
      entries: [
        { customType: MAIN_OFFSET_ENTRY, data: 0.5 },
        { customType: USAGE_ENTRY, data: { source: "agents", id: "a1", usage: usageTotals(0.4) } },
      ],
      usage: usageTotals(1.5),
    };
    const next = createFakeHost();

    next.files.set("/sessions/previous.jsonl", previous);
    bootSpending(next);
    next.start("/sessions/previous.jsonl");

    expect(next.statuses.get(STATUS_KEY)).toBe("main $2.00 · agents $0.40 · total $2.40");

    next.usage = usageTotals(0.25);
    next.emit(USAGE_CHANNEL, { source: "agents", id: "a1", usage: usageTotals(0.1) });

    expect(next.statuses.get(STATUS_KEY)).toBe("main $2.25 · agents $0.50 · total $2.75");
  });

  it("carries inherited totals into a fork of a fork", () => {
    const fork = { entries: [{ customType: MAIN_OFFSET_ENTRY, data: 1.5 }], usage: usageTotals(0.75) };
    const grandchild = createFakeHost();

    grandchild.files.set("/sessions/fork.jsonl", fork);
    grandchild.entries.push(...structuredClone(fork.entries));
    grandchild.usage = usageTotals(0.5);
    bootSpending(grandchild);
    grandchild.start("/sessions/fork.jsonl");
    grandchild.emit(USAGE_CHANNEL, { source: "agents", id: "a3", usage: usageTotals(0.1) });

    expect(grandchild.statuses.get(STATUS_KEY)).toBe("main $2.25 · agents $0.10 · total $2.35");
  });

  it("counts a new agent that draws the id of a parent agent, also after resuming the fork", () => {
    const parentEntry = {
      customType: USAGE_ENTRY,
      data: { source: "agents", id: "a1", usage: usageTotals(0.5) },
    };
    const fork = createFakeHost();

    fork.files.set("/sessions/parent.jsonl", { entries: [parentEntry], usage: usageTotals(0) });
    fork.entries.push(structuredClone(parentEntry));
    bootSpending(fork);
    fork.start("/sessions/parent.jsonl");
    fork.emit(USAGE_CHANNEL, { source: "agents", id: "a1", usage: usageTotals(0.1) });
    fork.settle();

    expect(fork.statuses.get(STATUS_KEY)).toBe("main $0.00 · agents $0.60 · total $0.60");

    const resumed = createFakeHost();

    resumed.entries.push(...fork.entries);
    bootSpending(resumed);
    resumed.start();

    expect(resumed.statuses.get(STATUS_KEY)).toBe("main $0.00 · agents $0.60 · total $0.60");
  });

  it("publishes the totals with chargeable tokens on every refresh", () => {
    const { host, report, lastTotals } = setup();

    expect(lastTotals()).toEqual({ main: { cost: 0, tokens: 0 }, sources: [], subscription: false });

    host.usage = usageTotals(1, 1000);
    report("agents", "a1", 0.5);

    expect(lastTotals()).toEqual({
      main: { cost: 1, tokens: 3000 },
      sources: [{ source: "agents", cost: 0.5, tokens: 300 }],
      subscription: false,
    });
    expect(parseTotals(lastTotals())).toEqual(lastTotals());
  });

  it("publishes the totals on turn end", () => {
    const { host, lastTotals } = setup();
    const published = () => host.published.filter((entry) => entry.channel === TOTALS_CHANNEL).length;

    host.usage = usageTotals(2);
    host.turnEnd({ tokens: 1, window: 2 });

    expect(published()).toBe(2);
    expect(lastTotals()).toEqual({ main: { cost: 2, tokens: 300 }, sources: [], subscription: false });
  });

  it("marks subscription sessions in the published totals", () => {
    const { lastTotals } = setup(true);

    expect(lastTotals()).toEqual({ main: { cost: 0, tokens: 0 }, sources: [], subscription: true });
  });

  it("counts cache writes and ignores pi's own token total", () => {
    const { host, lastTotals } = setup();

    host.usage = {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    };
    host.settle();

    expect(lastTotals()).toEqual({ main: { cost: 0.5, tokens: 100 }, sources: [], subscription: false });
  });

  it("keeps the main tokens across a handoff switch", () => {
    const previous = {
      entries: [{ customType: "pi-spending:main-tokens-offset", data: 500 }],
      usage: usageTotals(1, 1000),
    };
    const next = createFakeHost();
    const lastTotals = () => next.published.filter((entry) => entry.channel === TOTALS_CHANNEL).at(-1)?.data;

    next.files.set("/sessions/previous.jsonl", previous);
    bootSpending(next);
    next.start("/sessions/previous.jsonl");
    next.usage = usageTotals(0.25, 100);
    next.settle();

    expect(lastTotals()).toEqual({ main: { cost: 1.25, tokens: 3800 }, sources: [], subscription: false });
  });

  it("persists a report that arrives while the main session is idle at once", () => {
    const { report, usageEntries } = setup();

    report("agents", "a1", 0.1);

    expect(usageEntries().map((entry) => entry.data)).toEqual([
      { source: "agents", id: "a1", usage: usageTotals(0.1) },
    ]);
  });

  it("refreshes the footer after a compaction", () => {
    const { host, report } = setup();

    report("agents", "a1", 0.3);
    host.usage = usageTotals(1);
    host.compact();

    expect(host.statuses.get(STATUS_KEY)).toBe("main $1.00 · agents $0.30 · total $1.30");
  });

  it("inherits once when the session starts twice with the same parent, also after resuming", () => {
    const parent = {
      entries: [{ customType: USAGE_ENTRY, data: { source: "agents", id: "a1", usage: usageTotals(0.4) } }],
      usage: usageTotals(1),
    };
    const fork = createFakeHost();

    fork.files.set("/sessions/parent.jsonl", parent);
    bootSpending(fork);
    fork.start("/sessions/parent.jsonl");
    fork.start("/sessions/parent.jsonl");

    expect(fork.statuses.get(STATUS_KEY)).toBe("main $1.00 · agents $0.40 · total $1.40");
    expect(fork.entries.filter((entry) => entry.customType === MAIN_OFFSET_ENTRY)).toHaveLength(1);

    const resumed = createFakeHost();

    resumed.entries.push(...fork.entries);
    bootSpending(resumed);
    resumed.start();

    expect(resumed.statuses.get(STATUS_KEY)).toBe("main $1.00 · agents $0.40 · total $1.40");
  });

  it("falls back to the session's own entries and warns when the parent cannot be read", () => {
    const host = createFakeHost();

    host.entries.push(
      { customType: MAIN_OFFSET_ENTRY, data: 0.5 },
      { customType: USAGE_ENTRY, data: { source: "agents", id: "a1", usage: usageTotals(0.2) } },
    );
    bootSpending(host);
    host.start("/sessions/missing.jsonl");

    expect(host.statuses.get(STATUS_KEY)).toBe("main $0.50 · agents $0.20 · total $0.70");
    expect(host.notices).toEqual([
      {
        message: "spending: could not read the parent session missing.jsonl; totals cover this session only",
        level: "warning",
      },
    ]);
  });

  it("treats a corrupted offset entry as zero", () => {
    const host = createFakeHost();

    host.entries.push(
      { customType: MAIN_OFFSET_ENTRY, data: 0.5 },
      { customType: MAIN_OFFSET_ENTRY, data: "broken" },
      { customType: "pi-spending:main-tokens-offset", data: Number.NaN },
      { customType: USAGE_ENTRY, data: { source: "agents", id: "a1", usage: usageTotals(0.2) } },
    );
    host.usage = usageTotals(1);
    bootSpending(host);
    host.start();

    expect(host.statuses.get(STATUS_KEY)).toBe("main $1.00 · agents $0.20 · total $1.20");
    expect(host.published.at(-1)?.data).toMatchObject({ main: { cost: 1, tokens: 300 } });
  });
});
