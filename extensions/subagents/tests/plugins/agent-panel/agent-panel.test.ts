import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeLike } from "../../../../../platform/pi-adapter/index.ts";
import {
  createFakeAgentRuntime,
  createFakeHost,
  FAKE_FOOTER_KEY,
  plainTheme,
} from "../../../../../test/framework/index.ts";
import { agentPanelPlugin } from "../../../api/plugins/agent-panel.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import type { AgentRunner, AgentState, NewAgent, ServiceMap } from "../../../core/model/agent-record.ts";
import type { Plugin } from "../../../core/model/plugin.ts";
import type { Settings } from "../../../core/model/settings.ts";
import { newAgentInput } from "../../support/agent-records.ts";
import { selectedRow } from "../../support/overlay-rows.ts";
import { createHarness, startPlugins, tempDir } from "../../support/subagents-harness.ts";

const WIDGET = "pi-subagents-agents";

const IDLE = " ↓ to select";

const HINT = " esc to deselect · enter to view · x to stop";

const IDLE_MORE = (hidden: number) => `${IDLE} · ${hidden} more, ← to list agents`;

const HINT_MORE = (hidden: number) => `${HINT} · ${hidden} more, ← to list agents`;

const stubPlugin = <K extends keyof ServiceMap>(id: string, key: K, value: ServiceMap[K]): Plugin => ({
  id,
  enable: ({ services }) => {
    services.provide(key, value);
  },
});

const stubs = () => {
  const open = vi.fn(async () => {});
  const stop = vi.fn(async () => true);
  const runner = { stop, route: vi.fn(), abort: vi.fn() } as unknown as AgentRunner;

  return {
    open,
    stop,
    plugins: [stubPlugin("agent-view", "agentView", { open }), stubPlugin("run-agent", "runner", runner)],
  };
};

const setup = (options: { services?: boolean; settings?: Partial<Settings> } = {}) => {
  const stub = stubs();
  const plugins = options.services === false ? [] : stub.plugins;
  const harness = createHarness([agentRegistryPlugin, ...plugins, agentPanelPlugin], {
    overrides: options.settings,
  });
  const registry = harness.services.require("registry");
  const { host } = harness;

  const newAgent = (patch: Partial<NewAgent> = {}) =>
    registry.create(newAgentInput(join(harness.root, "agents"), patch));

  const running = (id: string) => registry.update(id, { state: "running", startedAt: Date.now() });
  const widget = () => host.widgets.get(WIDGET);
  const lines = (width = 80, theme: ThemeLike = plainTheme) => widget()?.(width, theme) ?? [];
  const key = (name: "up" | "down" | "left" | "right" | "enter" | "escape" | "tab") =>
    host.pressEditorKey({ name });
  const type = (char: string) => host.pressEditorKey({ name: "other", char });

  return { ...harness, ...stub, registry, newAgent, running, widget, lines, key, type };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("agent panel", () => {
  it("draws nothing at session start, so a footer block set then stays above the panel", () => {
    const panel = setup();

    expect(panel.host.belowEditor).toEqual([]);

    panel.host.ui.setFooter(() => ["usage"]);

    const record = panel.newAgent();

    expect(panel.host.belowEditor).toEqual([FAKE_FOOTER_KEY, WIDGET]);

    panel.running(record.id);
    panel.registry.close(record.id, { state: "done" });
    vi.advanceTimersByTime(11_001);

    expect(panel.host.belowEditor).toEqual([FAKE_FOOTER_KEY]);

    panel.newAgent();

    expect(panel.host.belowEditor).toEqual([FAKE_FOOTER_KEY, WIDGET]);
  });

  it("shows rows below the editor and removes the widget when the last row leaves", () => {
    const panel = setup();
    const record = panel.newAgent();

    expect(panel.lines()).toEqual(["   ◌ explorer  look around  Queued", "", IDLE, ""]);

    panel.running(record.id);
    panel.registry.close(record.id, { state: "done" });
    vi.advanceTimersByTime(9_999);

    expect(panel.widget()).toBeDefined();

    vi.advanceTimersByTime(1_002);

    expect(panel.widget()).toBeUndefined();
  });

  it("keeps failed rows failedLingerMs and done rows doneLingerMs", () => {
    const panel = setup();
    const done = panel.newAgent({ description: "finished" });
    const failed = panel.newAgent({ description: "broke" });

    panel.registry.close(done.id, { state: "done" });
    panel.registry.close(failed.id, { state: "failed", error: "boom" });
    vi.advanceTimersByTime(11_000);

    expect(panel.lines().join("\n")).not.toContain("finished");
    expect(panel.lines().join("\n")).toContain("broke");

    vi.advanceTimersByTime(20_000);

    expect(panel.widget()).toBeUndefined();
  });

  it("draws the running rows, the key hints and the hidden count as one table", () => {
    const panel = setup();
    const scout = panel.newAgent({ agent: "scout", description: "Map the auth module" });
    const worker = panel.newAgent({ agent: "worker", description: "Fix the login redirect" });

    panel.registry.update(scout.id, { state: "running", startedAt: 1_000_000 - 65_000, turns: 1 });
    panel.registry.update(scout.id, { toolCalls: 4, tokens: 12_300 });
    panel.registry.update(worker.id, { state: "running", startedAt: 1_000_000 - 123_000, turns: 1 });
    panel.registry.update(worker.id, { toolCalls: 18, tokens: 30_100 });
    Array.from({ length: 6 }, () => panel.running(panel.newAgent().id));
    panel.host.pressEmptyDown();
    panel.key("down");

    expect(panel.lines().slice(0, 2)).toEqual([
      "   ⠋ scout     Map the auth module     Elapsed 1m 5s · 4 calls · 12.3k tokens",
      " › ⠋ worker    Fix the login redirect  Elapsed 2m 3s · 18 calls · 30.1k tokens",
    ]);
    expect(panel.lines().slice(-2)).toEqual([HINT_MORE(3), ""]);
  });

  it("draws a lead with three children nested when they fit", () => {
    const panel = setup();
    const lead = panel.newAgent({ agent: "reviewer" });

    panel.running(lead.id);
    Array.from({ length: 3 }, (_, index) =>
      panel.running(panel.newAgent({ callerId: lead.id, depth: 1, description: `child ${index}` }).id),
    );

    const lines = panel.lines();

    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("reviewer (+3)");
    expect(lines[1]?.startsWith("   ↳ ⠋ explorer")).toBe(true);
    expect(lines.slice(1, 4).every((line) => line.includes("child"))).toBe(true);
    expect(lines.slice(-2)).toEqual([IDLE, ""]);
  });

  it("collapses an overflowing tree to its leads and counts the children in the hint", () => {
    const panel = setup();
    const leads = ["reviewer", "planner"].map((agent) => panel.newAgent({ agent }));

    leads.forEach((lead) => {
      panel.running(lead.id);
      Array.from({ length: 3 }, () =>
        panel.running(panel.newAgent({ callerId: lead.id, depth: 1, description: "child" }).id),
      );
    });

    const lines = panel.lines();

    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("reviewer (+3)");
    expect(lines[1]).toContain("planner (+3)");
    expect(lines.join("\n")).not.toContain("child");
    expect(lines.slice(2)).toEqual(["", IDLE_MORE(6), ""]);
  });

  it("down on an empty editor selects the first row and installs a capture", () => {
    const panel = setup();

    panel.newAgent();
    panel.host.pressEmptyDown();

    const lines = panel.lines();

    expect(selectedRow(lines)).toBe(lines[0]);
    expect(lines.at(-2)).toBe(HINT);
    expect(lines.at(-1)).toBe("");
    expect(panel.host.editorCapture).toBeDefined();
  });

  it("selects the first row when the plugin was enabled before the session started", () => {
    const panel = setup();

    panel.newAgent();

    expect(panel.host.pressEmptyDown()).toBe(true);
    expect(selectedRow(panel.lines())).toBeDefined();
  });

  it("down with no rows does nothing", () => {
    const panel = setup();

    panel.host.pressEmptyDown();

    expect(panel.host.editorCapture).toBeUndefined();
    expect(panel.widget()).toBeUndefined();
  });

  it("moves the selection and stops on the last shown row", () => {
    const panel = setup();

    Array.from({ length: 7 }, () => panel.running(panel.newAgent().id));
    panel.host.pressEmptyDown();
    Array.from({ length: 6 }, () => panel.key("down"));

    const lines = panel.lines();

    expect(lines[0]).not.toBe("");
    expect(selectedRow(lines)).toBe(lines[4]);
    expect(lines.slice(5)).toEqual(["", HINT_MORE(2), ""]);
  });

  it("keeps open agents before closed ones when they overflow", () => {
    const panel = setup();
    const records = Array.from({ length: 7 }, (_, index) => panel.newAgent({ description: `task ${index}` }));

    records.forEach((record) => {
      panel.running(record.id);
    });
    records.slice(0, 2).forEach((record) => {
      panel.registry.close(record.id, { state: "done" });
    });

    const lines = panel.lines();

    expect(lines.slice(0, 5).map((line) => line.match(/task \d/)?.[0])).toEqual([
      "task 2",
      "task 3",
      "task 4",
      "task 5",
      "task 6",
    ]);
    expect(lines.slice(5)).toEqual(["", IDLE_MORE(2), ""]);
  });

  it("keeps the selected agent shown when it would be cut", () => {
    const panel = setup();
    const records = Array.from({ length: 7 }, (_, index) => panel.newAgent({ description: `task ${index}` }));

    records.forEach((record) => {
      panel.running(record.id);
    });
    panel.host.pressEmptyDown();
    Array.from({ length: 2 }, () => panel.key("down"));
    panel.registry.close(records[2].id, { state: "done" });
    vi.advanceTimersByTime(1_000);

    const lines = panel.lines();

    expect(lines.slice(0, 5).map((line) => line.match(/task \d/)?.[0])).toEqual([
      "task 0",
      "task 1",
      "task 3",
      "task 4",
      "task 2",
    ]);
    expect(selectedRow(lines)).toBe(lines[4]);
    expect(lines.at(-2)?.endsWith(" · 2 more, ← to list agents")).toBe(true);
  });

  it("moves a selected child to its lead when the tree collapses and keeps every lead drawn", () => {
    const panel = setup();
    const lead = panel.newAgent({ agent: "reviewer" });

    panel.running(lead.id);
    Array.from({ length: 4 }, (_, index) =>
      panel.running(panel.newAgent({ callerId: lead.id, depth: 1, description: `child ${index}` }).id),
    );
    panel.host.pressEmptyDown();
    Array.from({ length: 4 }, () => panel.key("down"));

    expect(selectedRow(panel.lines())).toContain("child 3");

    panel.running(panel.newAgent({ agent: "planner" }).id);
    vi.advanceTimersByTime(1_000);

    const lines = panel.lines();

    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("reviewer (+4)");
    expect(lines[1]).toContain("planner");
    expect(selectedRow(lines)).toBe(lines[0]);
    expect(lines.at(-2)).toBe(HINT_MORE(4));
  });

  it("draws a collapsed selected child as its lead, not nested under another lead", () => {
    const panel = setup();
    const lead = panel.newAgent({ agent: "reviewer" });

    panel.running(lead.id);
    panel.running(panel.newAgent({ callerId: lead.id, depth: 1, description: "nested" }).id);
    panel.host.pressEmptyDown();
    panel.key("down");
    Array.from({ length: 5 }, () => panel.running(panel.newAgent().id));
    vi.advanceTimersByTime(1_000);

    const lines = panel.lines();
    const selected = selectedRow(lines);

    expect(selected).toBe(lines[0]);
    expect(selected).toContain("reviewer (+1)");
    expect(lines.join("\n")).not.toContain("↳");
  });

  it("ranks a closed lead with a running child as open", () => {
    const panel = setup();
    const lead = panel.newAgent({ agent: "reviewer" });

    panel.running(lead.id);
    panel.running(panel.newAgent({ callerId: lead.id, depth: 1, description: "nested" }).id);
    panel.registry.close(lead.id, { state: "done" });
    Array.from({ length: 5 }, () => panel.running(panel.newAgent().id));
    vi.advanceTimersByTime(1_000);

    const lines = panel.lines();

    expect(lines[0]).toContain("reviewer (+1)");
    expect(lines.at(-2)).toBe(IDLE_MORE(2));
  });

  it("keeps the cleared row's slot selected when the pinned row had no successor", () => {
    const panel = setup();
    const records = Array.from({ length: 7 }, (_, index) => panel.newAgent({ description: `task ${index}` }));

    records.forEach((record) => {
      panel.running(record.id);
    });
    panel.host.pressEmptyDown();
    Array.from({ length: 4 }, () => panel.key("down"));
    panel.registry.close(records[4].id, { state: "done" });
    vi.advanceTimersByTime(1_000);

    expect(selectedRow(panel.lines())).toContain("task 4");

    panel.type("x");

    const lines = panel.lines();

    expect(selectedRow(lines)).toBe(lines[4]);
    expect(lines[4]).toContain("task 5");
  });

  it("enter opens the agent view from the panel and deselects", () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.host.pressEmptyDown();

    expect(panel.key("enter")).toBe("consumed");
    expect(panel.open).toHaveBeenCalledWith(record.id);
    expect(selectedRow(panel.lines())).toBeUndefined();
    expect(panel.host.editorCapture).toBeUndefined();
  });

  it("x stops a running agent through the runner and clears a done row for good", () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.running(record.id);
    panel.host.pressEmptyDown();

    expect(panel.type("x")).toBe("consumed");
    expect(panel.stop).toHaveBeenCalledTimes(1);
    expect(panel.stop).toHaveBeenCalledWith(record.id);

    panel.registry.close(record.id, { state: "done" });

    expect(panel.type("x")).toBe("consumed");
    expect(panel.widget()).toBeUndefined();

    vi.advanceTimersByTime(1);

    expect(panel.widget()).toBeUndefined();
    expect(panel.host.editorCapture).toBeUndefined();
  });

  it("x keeps the selection on a running row it stops", () => {
    const panel = setup();

    Array.from({ length: 2 }, () => panel.running(panel.newAgent().id));
    panel.host.pressEmptyDown();
    panel.key("down");

    const before = selectedRow(panel.lines());

    expect(panel.type("x")).toBe("consumed");
    expect(panel.stop).toHaveBeenCalledWith(panel.registry.list()[1].id);
    expect(selectedRow(panel.lines())).toEqual(before);
    expect(panel.host.editorCapture).toBeDefined();
  });

  it("x on a grace row closes it now through the runner", () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.registry.update(record.id, { state: "grace" });
    panel.host.pressEmptyDown();

    expect(panel.lines().at(-2)).toBe(" esc to deselect · enter to view · x to close now");
    expect(panel.type("x")).toBe("consumed");
    expect(panel.stop).toHaveBeenCalledWith(record.id);
    expect(selectedRow(panel.lines())).toBeDefined();
  });

  it("x on a done row clears it and keeps the selection on the next row", () => {
    const panel = setup();
    const done = panel.newAgent({ description: "finished" });

    panel.registry.close(done.id, { state: "done" });
    panel.running(panel.newAgent({ description: "second" }).id);
    panel.host.pressEmptyDown();

    expect(panel.type("x")).toBe("consumed");

    const lines = panel.lines();

    expect(lines.join("\n")).not.toContain("finished");
    expect(selectedRow(lines)).toContain("second");
    expect(lines).toContain(HINT);
    expect(panel.host.editorCapture).toBeDefined();
  });

  it("x on the last row, a done one, moves the selection to the previous row", () => {
    const panel = setup();

    panel.running(panel.newAgent({ description: "first" }).id);

    const done = panel.newAgent({ description: "finished" });

    panel.registry.close(done.id, { state: "done" });
    panel.host.pressEmptyDown();
    panel.key("down");
    panel.type("x");

    expect(selectedRow(panel.lines())).toContain("first");
    expect(panel.host.editorCapture).toBeDefined();
  });

  it("releases the capture when the selected row lingered out before the next tick", () => {
    const panel = setup();
    const record = panel.newAgent({ description: "finished" });

    panel.registry.close(record.id, { state: "done" });
    panel.host.pressEmptyDown();
    vi.setSystemTime(Date.now() + 10_000);

    expect(panel.key("down")).toBe("release");
    expect(panel.host.editorCapture).toBeUndefined();
  });

  it("reports a rejected stop", async () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.stop.mockRejectedValueOnce(new Error("runner gone"));
    panel.running(record.id);
    panel.host.pressEmptyDown();
    panel.type("x");
    await vi.advanceTimersByTimeAsync(0);

    expect(panel.host.notices).toContainEqual({
      message: "pi-subagents: stop failed: runner gone",
      level: "warning",
    });
  });

  it("a released key clears the selection and reaches the editor", () => {
    const panel = setup();

    panel.newAgent();
    panel.host.pressEmptyDown();

    expect(panel.type("a")).toBe("release");

    const lines = panel.lines();

    expect(selectedRow(lines)).toBeUndefined();
    expect(lines).not.toContain(HINT);
    expect(panel.host.editorCapture).toBeUndefined();
  });

  it("left on a selected row deselects and releases the capture", () => {
    const panel = setup();

    Array.from({ length: 3 }, () => panel.newAgent());
    panel.host.pressEmptyDown();
    panel.key("down");

    expect(panel.key("left")).toBe("release");
    expect(selectedRow(panel.lines())).toBeUndefined();
    expect(panel.host.editorCapture).toBeUndefined();
  });

  it("left on an empty editor does not select a row", () => {
    const panel = setup();

    panel.newAgent();

    expect(panel.host.pressEmptyLeft()).toBe(false);
    expect(selectedRow(panel.lines())).toBeUndefined();
    expect(panel.host.editorCapture).toBeUndefined();
  });

  it("down on the last row keeps the selection there", () => {
    const panel = setup();

    Array.from({ length: 2 }, () => panel.newAgent());
    panel.host.pressEmptyDown();
    panel.key("down");

    const before = panel.lines();

    expect(panel.key("down")).toBe("consumed");
    expect(panel.lines()).toEqual(before);
    expect(selectedRow(before)).toBeDefined();
  });

  it("right on a selected row deselects and releases the capture", () => {
    const panel = setup();

    panel.newAgent();
    panel.host.pressEmptyDown();

    expect(panel.key("right")).toBe("release");
    expect(selectedRow(panel.lines())).toBeUndefined();
    expect(panel.host.editorCapture).toBeUndefined();
  });

  it("esc deselects without reaching the editor", () => {
    const panel = setup();

    panel.newAgent();
    panel.host.pressEmptyDown();

    expect(panel.key("escape")).toBe("consumed");
    expect(selectedRow(panel.lines())).toBeUndefined();
  });

  it("deselects and releases the capture when the selected row leaves", () => {
    const panel = setup();
    const first = panel.newAgent({ description: "first" });

    panel.running(first.id);
    panel.registry.close(first.id, { state: "done" });
    panel.host.pressEmptyDown();
    panel.running(panel.newAgent({ description: "second" }).id);

    expect(selectedRow(panel.lines())).toContain("first");

    vi.advanceTimersByTime(10_001);

    expect(panel.host.editorCapture).toBeUndefined();
    expect(selectedRow(panel.lines())).toBeUndefined();
    expect(panel.lines().join("\n")).toContain("second");
  });

  it("keeps the rows in place when the selection clears", () => {
    const panel = setup();

    Array.from({ length: 7 }, () => panel.running(panel.newAgent().id));
    panel.host.pressEmptyDown();
    Array.from({ length: 3 }, () => panel.key("down"));

    const selected = panel.lines();

    panel.key("escape");

    const after = panel.lines();

    expect(selectedRow(after)).toBeUndefined();
    expect(selected.at(-2)).toBe(HINT_MORE(2));
    expect(after.at(-2)).toBe(IDLE_MORE(2));
    expect(after.slice(0, 5)).toEqual([...selected.slice(0, 3), selected[3].replace("›", " "), selected[4]]);
  });

  it("is eight lines from six agents up and three more than the count below, never starting blank", () => {
    const heights = [1, 2, 5, 6, 7, 10].map((count) => {
      const panel = setup();

      Array.from({ length: count }, () => panel.running(panel.newAgent().id));

      const idle = panel.lines();

      panel.host.pressEmptyDown();
      Array.from({ length: 9 }, () => panel.key("down"));

      const selected = panel.lines();

      expect([idle[0], selected[0]]).not.toContain("");

      expect([idle.at(-3), selected.at(-3)]).toEqual(["", ""]);

      return [idle.length, selected.length, idle.at(-2), selected.at(-2)];
    });

    expect(heights).toEqual([
      [4, 4, IDLE, HINT],
      [5, 5, IDLE, HINT],
      [8, 8, IDLE, HINT],
      [8, 8, IDLE_MORE(1), HINT_MORE(1)],
      [8, 8, IDLE_MORE(2), HINT_MORE(2)],
      [8, 8, IDLE_MORE(5), HINT_MORE(5)],
    ]);
  });

  it("keeps the panel height when selecting a short list", () => {
    const panel = setup();

    Array.from({ length: 3 }, () => panel.running(panel.newAgent().id));

    const idle = panel.lines();

    panel.host.pressEmptyDown();

    const selected = panel.lines();

    expect([idle.length, selected.length]).toEqual([6, 6]);
    expect([idle.at(-2), selected.at(-2)]).toEqual([IDLE, HINT]);
  });

  it("ticks every 100 ms while a row runs, every second with only queued rows, and never when empty", () => {
    const empty = setup();

    expect(vi.getTimerCount()).toBe(0);
    expect(empty.widget()).toBeUndefined();

    const panel = setup();
    const record = panel.newAgent();

    panel.lines();

    const queuedStart = panel.host.widgetRefreshes;

    vi.advanceTimersByTime(999);

    expect(panel.host.widgetRefreshes).toBe(queuedStart);

    vi.advanceTimersByTime(1);

    expect(panel.host.widgetRefreshes).toBe(queuedStart + 1);

    panel.running(record.id);

    const runningStart = panel.host.widgetRefreshes;

    vi.advanceTimersByTime(1_000);

    expect(panel.host.widgetRefreshes - runningStart).toBeGreaterThanOrEqual(9);

    const idle = setup();
    const done = idle.newAgent({ description: "finished" });

    idle.newAgent({ description: "waiting" });
    idle.registry.close(done.id, { state: "done" });
    vi.advanceTimersByTime(9_500);
    idle.lines();

    expect(idle.lines().join("\n")).toContain("finished");

    vi.advanceTimersByTime(1_000);

    expect(idle.lines().join("\n")).not.toContain("finished");
    expect(idle.lines().join("\n")).toContain("waiting");
  });

  it("renders from the rows of the last refresh: ten render calls between ticks read the registry zero times", () => {
    const panel = setup();

    panel.running(panel.newAgent().id);

    const list = vi.spyOn(panel.registry, "list");
    const frames = Array.from({ length: 10 }, () => panel.lines());

    expect(list).not.toHaveBeenCalled();
    expect(new Set(frames.map((lines) => lines.join("\n"))).size).toBe(1);

    vi.advanceTimersByTime(100);

    expect(list).toHaveBeenCalledTimes(1);
    expect(panel.lines()).not.toEqual(frames[0]);
  });

  it("builds the rows once per throttle window across five updates", () => {
    const panel = setup({ settings: { renderThrottleMs: 250 } });
    const record = panel.newAgent();

    vi.advanceTimersByTime(500);

    const start = panel.host.widgetRefreshes;

    Array.from({ length: 5 }, (_, index) => panel.registry.update(record.id, { tokens: (index + 1) * 100 }));

    expect(panel.host.widgetRefreshes).toBe(start + 1);

    vi.advanceTimersByTime(249);

    expect(panel.host.widgetRefreshes).toBe(start + 1);

    vi.advanceTimersByTime(1);

    expect(panel.host.widgetRefreshes).toBe(start + 2);
  });

  it.each([
    ["queued", " esc to deselect · enter to view · x to stop"],
    ["running", " esc to deselect · enter to view · x to stop"],
    ["grace", " esc to deselect · enter to view · x to close now"],
    ["done", " esc to deselect · enter to view · x to clear"],
  ] as [AgentState, string][])("hints the actions for a selected %s row", (state, hint) => {
    const panel = setup();
    const record = panel.newAgent();

    if (state === "done") {
      panel.registry.close(record.id, { state });
    } else {
      panel.registry.update(record.id, { state });
    }

    panel.host.pressEmptyDown();

    expect(panel.lines().at(-2)).toBe(hint);
  });

  it("aligns the info column over the shown rows and keeps it while the selection moves", () => {
    const panel = setup();

    Array.from({ length: 7 }, (_, index) =>
      panel.running(panel.newAgent({ description: "d".repeat(10 + index * 3) }).id),
    );
    panel.host.pressEmptyDown();

    const infoColumns = (lines: string[]) =>
      lines.filter((line) => line.includes("⠋")).map((line) => line.lastIndexOf("  ") + 2);
    const top = infoColumns(panel.lines(120));

    Array.from({ length: 6 }, () => panel.key("down"));

    const bottom = infoColumns(panel.lines(120));

    expect(top).toHaveLength(5);
    expect(new Set([...top, ...bottom]).size).toBe(1);
    expect(top[0]).toBe("   ".length + 2 + plainTheme.width("explorer") + 2 + 22 + 2);
  });

  it("keeps the rows in the glyph column and every line within the width", () => {
    const panel = setup();

    Array.from({ length: 7 }, () => panel.running(panel.newAgent().id));
    panel.host.pressEmptyDown();

    const lines = panel.lines();
    const glyphColumn = lines[0].indexOf("⠋");

    expect(glyphColumn).toBe(3);

    [80, 30].forEach((width) => {
      const drawn = panel.lines(width);

      drawn.forEach((line) => {
        expect(plainTheme.width(line)).toBeLessThanOrEqual(width);
      });
      expect(drawn.slice(0, -3).every((line) => line.startsWith(" "))).toBe(true);
      expect(drawn.at(-2)?.startsWith(" ")).toBe(true);
      expect([drawn.at(-3), drawn.at(-1)]).toEqual(["", ""]);
    });

    expect(panel.lines(30).at(-2)).toBe(" esc to deselect · enter to...");
  });

  it("degrades without agent-view and run-agent", () => {
    const panel = setup({ services: false });
    const run = panel.newAgent({ description: "busy" });
    const done = panel.newAgent({ description: "finished" });

    panel.running(run.id);
    panel.registry.close(done.id, { state: "done" });
    panel.host.pressEmptyDown();

    expect(panel.lines().at(-2)).toBe(" esc to deselect");
    expect(panel.key("enter")).toBe("consumed");

    panel.host.pressEmptyDown();

    expect(panel.type("x")).toBe("consumed");
    expect(panel.registry.get(run.id)?.state).toBe("running");

    panel.key("down");

    expect(panel.lines().at(-2)).toBe(" esc to deselect · x to clear");

    panel.type("x");

    expect(panel.lines().join("\n")).not.toContain("finished");
  });

  it("does nothing with a foreign editor", () => {
    const root = tempDir();
    const host = createFakeHost({
      id: "foreign",
      file: join(root, "main.jsonl"),
      agentDir: join(root, "agent"),
    });

    host.foreignEditor = true;

    const { services } = startPlugins(host, createFakeAgentRuntime(), [
      agentRegistryPlugin,
      agentPanelPlugin,
    ]);

    services.require("registry").create(newAgentInput(join(root, "agents")));

    expect(host.pressEmptyDown()).toBe(false);
    expect(host.widgets.get(WIDGET)?.(80, plainTheme)).toHaveLength(4);
  });

  it("removes the widget and the capture on disable", async () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.running(record.id);
    panel.host.pressEmptyDown();
    await panel.manager.disableAll();

    expect(panel.widget()).toBeUndefined();
    expect(panel.host.editorCapture).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("agents hint status", () => {
  const hint = (panel: ReturnType<typeof setup>) => panel.host.statuses.get("pi-subagents");

  it("is set while the panel shows no rows and unset while it lists any", () => {
    const panel = setup();

    expect(hint(panel)).toContain("← to list agents");

    const record = panel.newAgent();

    panel.running(record.id);

    expect(hint(panel)).toBeUndefined();

    panel.registry.close(record.id, { state: "done" });

    expect(hint(panel)).toBeUndefined();

    vi.advanceTimersByTime(9_999);

    expect(hint(panel)).toBeUndefined();

    vi.advanceTimersByTime(1_002);

    expect(hint(panel)).toContain("← to list agents");
  });

  it("returns when x clears the last lingering failed row", () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.running(record.id);
    panel.registry.close(record.id, { state: "failed" });
    panel.host.pressEmptyDown();

    expect(hint(panel)).toBeUndefined();

    panel.type("x");

    expect(hint(panel)).toContain("← to list agents");
  });

  it("is never set with agent-view disabled", () => {
    const panel = setup({ settings: { disabledPlugins: ["agent-view"] } });
    const record = panel.newAgent();

    panel.running(record.id);
    panel.registry.close(record.id, { state: "done" });
    vi.advanceTimersByTime(12_000);

    expect(hint(panel)).toBeUndefined();
    expect(panel.host.statuses.get("pi-subagents")).toBeUndefined();
  });

  it("is never set outside tui", () => {
    const panel = setup();

    panel.host.statuses.clear();
    panel.host.info.mode = "rpc";
    panel.host.start();

    const record = panel.newAgent();

    panel.running(record.id);
    panel.registry.close(record.id, { state: "done" });
    vi.advanceTimersByTime(12_000);

    expect(hint(panel)).toBeUndefined();
  });

  it("never calls setStatus for a session started in rpc mode", async () => {
    const root = tempDir();

    const host = createFakeHost({
      id: "rpc",
      mode: "rpc",
      file: join(root, "main.jsonl"),
      agentDir: join(root, "agent"),
    });

    const { manager } = startPlugins(host, createFakeAgentRuntime(), [agentRegistryPlugin, agentPanelPlugin]);

    expect(host.statusCalls).toEqual([]);

    await manager.disableAll();

    expect(host.statusCalls).toEqual([]);
  });

  it("comes back at a new session start after pi clears statuses", () => {
    const panel = setup();

    panel.host.statuses.clear();

    expect(hint(panel)).toBeUndefined();

    panel.host.start();

    expect(hint(panel)).toContain("← to list agents");
  });

  it("is written only on change", () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.running(record.id);
    panel.host.statusCalls.length = 0;
    vi.advanceTimersByTime(3_000);
    panel.running(record.id);
    vi.advanceTimersByTime(3_000);

    expect(panel.host.statusCalls).toEqual([]);
  });

  it("is hidden while a queued row shows", () => {
    const panel = setup();

    panel.newAgent();

    expect(panel.lines().join("\n")).toContain("Queued");
    expect(hint(panel)).toBeUndefined();
  });

  it("is hidden while a stopping row shows", () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.running(record.id);
    panel.registry.update(record.id, { state: "grace" });

    expect(panel.lines().join("\n")).toContain("Stopping");
    expect(hint(panel)).toBeUndefined();
  });

  it("is cleared on disable and not set again", async () => {
    const panel = setup();

    await panel.manager.disableAll();

    expect(hint(panel)).toBeUndefined();

    panel.host.start();
    panel.registry.create(newAgentInput(join(panel.root, "agents"), {}));

    expect(hint(panel)).toBeUndefined();
  });
});
