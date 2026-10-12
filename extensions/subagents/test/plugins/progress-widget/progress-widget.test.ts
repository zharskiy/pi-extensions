import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainTheme } from "../../../../../core/test/helpers/fakes.ts";
import type { NewAgent } from "../../../src/model/types.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { progressWidgetPlugin, WIDGET_KEY } from "../../../src/plugins/progress-widget/index.ts";
import {
  createClosedRowCache,
  createThrottle,
  visibleRecords,
} from "../../../src/plugins/progress-widget/model.ts";
import { createHarness } from "../../helpers/harness.ts";

const newAgent = (patch: Partial<NewAgent> = {}): NewAgent => ({
  agent: "explorer",
  task: "t",
  description: "look around",
  callerId: "main",
  depth: 2,
  batchId: "b-1",
  dir: "/tmp/pi-subagents-widget",
  contextLimit: 100_000,
  ...patch,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("throttle", () => {
  it("runs at most once per interval and keeps a trailing call", () => {
    const run = vi.fn();
    const throttled = createThrottle(run, () => 250);

    throttled();
    throttled();
    throttled();

    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(249);

    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);

    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("linger", () => {
  it("keeps finished rows about 30 seconds and failed or stopped rows longer", () => {
    const settings = { lingerMs: 30_000, failedLingerMs: 60_000 };
    const base = { endedAt: 0 };

    const records = [
      { state: "done", ...base },
      { state: "failed", ...base },
      { state: "stopped", ...base },
      { state: "running" },
    ].map((patch, index) => ({ id: `a${index}`, ...patch })) as never[];

    expect(visibleRecords(records, 29_999, settings).map((record: { id: string }) => record.id)).toEqual([
      "a0",
      "a1",
      "a2",
      "a3",
    ]);
    expect(visibleRecords(records, 30_000, settings).map((record: { id: string }) => record.id)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
    expect(visibleRecords(records, 60_000, settings).map((record: { id: string }) => record.id)).toEqual([
      "a3",
    ]);
  });
});

describe("closed row cache", () => {
  it("reuses a closed row until its record changes and always redraws open rows", () => {
    const harness = createHarness([agentRegistryPlugin]);
    const registry = harness.services.require("registry");
    const open = registry.create(newAgent());
    const closed = registry.create(newAgent({ description: "finished" }));
    const rowCache = createClosedRowCache();
    let boldCalls = 0;

    const countingTheme = {
      ...plainTheme,
      bold: (text: string) => {
        boldCalls += 1;
        return text;
      },
    };

    registry.close(closed.id, { state: "done" });

    const first = rowCache(closed, Date.now(), 0, countingTheme, 120);
    const second = rowCache(closed, Date.now() + 5_000, 1, countingTheme, 120);

    expect(second).toBe(first);
    expect(boldCalls).toBe(1);

    rowCache(open, Date.now(), 0, countingTheme, 120);
    rowCache(open, Date.now(), 0, countingTheme, 120);

    expect(boldCalls).toBe(3);

    registry.update(closed.id, { tokens: 500 });
    rowCache(closed, Date.now(), 0, countingTheme, 120);
    rowCache(closed, Date.now(), 0, countingTheme, 80);

    expect(boldCalls).toBe(5);
  });
});

describe("progress widget plugin", () => {
  it("stops redrawing on ticks once every visible agent is closed and unchanged", () => {
    const harness = createHarness([agentRegistryPlugin, progressWidgetPlugin], { renderThrottleMs: 0 });
    const registry = harness.services.require("registry");
    const record = registry.create(newAgent());

    vi.advanceTimersByTime(3_000);

    const whileOpen = harness.host.widgetRefreshes;

    expect(whileOpen).toBeGreaterThanOrEqual(3);

    registry.close(record.id, { state: "done" });
    vi.advanceTimersByTime(1);

    const afterClose = harness.host.widgetRefreshes;

    vi.advanceTimersByTime(5_000);

    expect(afterClose).toBe(whileOpen + 1);
    expect(harness.host.widgetRefreshes).toBe(afterClose);
  });

  it("shows running agents below the editor and removes the widget after the linger window", () => {
    const harness = createHarness([agentRegistryPlugin, progressWidgetPlugin], { renderThrottleMs: 250 });
    const registry = harness.services.require("registry");
    const record = registry.create(newAgent());

    vi.advanceTimersByTime(250);

    const render = harness.host.widgets.get(WIDGET_KEY);

    expect(render).toBeDefined();
    expect(render?.(120, plainTheme)).toEqual([
      "Agents · 1 running · /agents to browse",
      expect.stringMatching(new RegExp(`^○ ${record.id} · look around · queued`)),
    ]);

    registry.update(record.id, { state: "running", startedAt: Date.now() });
    registry.close(record.id, { state: "done" });

    vi.advanceTimersByTime(29_000);

    expect(harness.host.widgets.get(WIDGET_KEY)).toBeDefined();

    vi.advanceTimersByTime(2_000);

    expect(harness.host.widgets.get(WIDGET_KEY)).toBeUndefined();
  });

  it("indents nested agents by depth", () => {
    const harness = createHarness([agentRegistryPlugin, progressWidgetPlugin], { renderThrottleMs: 0 });
    const registry = harness.services.require("registry");

    registry.create(newAgent());
    registry.create(newAgent({ depth: 3, description: "nested" }));
    vi.advanceTimersByTime(1);

    const lines = harness.host.widgets.get(WIDGET_KEY)?.(120, plainTheme) ?? [];

    expect(lines[2]).toMatch(/^ {2}○ explorer-\w+ · nested/);
  });

  it("shows the stop grace countdown and pauses it while the agent answers", () => {
    const harness = createHarness([agentRegistryPlugin, progressWidgetPlugin], { renderThrottleMs: 0 });
    const registry = harness.services.require("registry");
    const record = registry.create(newAgent());

    registry.update(record.id, { state: "grace", startedAt: Date.now(), graceEndsAt: Date.now() + 60_000 });
    vi.advanceTimersByTime(18_000);

    const render = () => harness.host.widgets.get(WIDGET_KEY)?.(120, plainTheme) ?? [];

    expect(render()[1]).toMatch(new RegExp(`^◐ ${record.id} · look around · .* · stopping in 42s$`));

    registry.update(record.id, { graceEndsAt: undefined });

    expect(render()[1]).toMatch(/ · stopping · answering$/);
  });
});
