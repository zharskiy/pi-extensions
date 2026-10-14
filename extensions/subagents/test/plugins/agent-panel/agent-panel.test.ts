import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeLike } from "../../../../../core/adapter/contract.ts";
import {
  createFakeHost,
  createFakeRuntime,
  FAKE_FOOTER_KEY,
  plainTheme,
} from "../../../../../core/test/helpers/fakes.ts";
import type { Plugin } from "../../../src/model/plugin.ts";
import type { Settings } from "../../../src/model/settings.ts";
import type { AgentRunner, NewAgent, ServiceMap } from "../../../src/model/types.ts";
import { agentPanelPlugin } from "../../../src/plugins/agent-panel/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { createHarness, startPlugins, tempDir } from "../../helpers/harness.ts";

const WIDGET = "pi-subagents-agents";

const STATUS = "pi-subagents";

const HINT = " enter to view · x to stop · esc to deselect";

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
  const harness = createHarness([agentRegistryPlugin, ...plugins, agentPanelPlugin], options.settings);
  const registry = harness.services.require("registry");
  const { host } = harness;

  const newAgent = (patch: Partial<NewAgent> = {}) =>
    registry.create({
      agent: "explorer",
      description: "look around",
      callerId: "main",
      depth: 2,
      batchId: "b-1",
      dir: join(harness.root, "agents"),
      contextLimit: 100_000,
      ...patch,
    });

  const running = (id: string) => registry.update(id, { state: "running", startedAt: Date.now() });
  const widget = () => host.widgets.get(WIDGET);
  const lines = (width = 80, theme: ThemeLike = plainTheme) => widget()?.(width, theme) ?? [];
  const key = (name: "up" | "down" | "left" | "right" | "enter" | "escape" | "tab") =>
    host.pressEditorKey({ name });
  const type = (char: string) => host.pressEditorKey({ name: "other", char });

  return { ...harness, ...stub, registry, newAgent, running, widget, lines, key, type };
};

const pointed = (lines: string[]) => lines.filter((line) => line.startsWith(" › "));

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

    panel.host.ui.setFooter(() => ["usage"], { slot: "belowEditor" });

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

    expect(panel.lines()).toEqual([expect.stringMatching(/^ ○ explorer {2}look around +queued$/), ""]);

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

  it("renders seven agents in tree order with markers and (+N)", () => {
    const panel = setup();
    const parent = panel.newAgent({ agent: "reviewer" });

    panel.running(parent.id);
    panel.running(panel.newAgent({ callerId: parent.id, depth: 3, description: "nested" }).id);
    Array.from({ length: 6 }, () => panel.running(panel.newAgent().id));

    const lines = panel.lines();

    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("reviewer (+1)");
    expect(lines[1].startsWith(" └─ ")).toBe(true);
    expect(lines[1]).toContain("nested");
    expect(lines.slice(5)).toEqual([" ↓ 3 more", ""]);
  });

  it("left on an empty editor selects the first row and installs a capture", () => {
    const panel = setup();

    panel.newAgent();
    panel.host.pressEmptyLeft();

    const lines = panel.lines();

    expect(lines[0].startsWith(" › ")).toBe(true);
    expect(lines.at(-2)).toBe(HINT);
    expect(lines.at(-1)).toBe("");
    expect(panel.host.editorCapture).toBeDefined();
  });

  it("selects the first row when the plugin was enabled before the session started", () => {
    const panel = setup();

    panel.newAgent();

    expect(panel.host.pressEmptyLeft()).toBe(true);
    expect(pointed(panel.lines())).toHaveLength(1);
  });

  it("left with no rows does nothing", () => {
    const panel = setup();

    panel.host.pressEmptyLeft();

    expect(panel.host.editorCapture).toBeUndefined();
    expect(panel.widget()).toBeUndefined();
  });

  it("moves the selection and scrolls the window", () => {
    const panel = setup();

    Array.from({ length: 7 }, () => panel.running(panel.newAgent().id));
    panel.host.pressEmptyLeft();
    Array.from({ length: 5 }, () => panel.key("down"));

    const lines = panel.lines();

    expect(lines[0]).toBe(" ↑ 1 more");
    expect(lines[5].startsWith(" › ")).toBe(true);
    expect(pointed(lines)).toHaveLength(1);
  });

  it("scrolls the window up to keep the selection visible", () => {
    const panel = setup();

    Array.from({ length: 7 }, () => panel.running(panel.newAgent().id));
    panel.host.pressEmptyLeft();
    Array.from({ length: 6 }, () => panel.key("down"));
    Array.from({ length: 5 }, () => panel.key("up"));

    const lines = panel.lines();

    expect(lines[0]).toBe(" ↑ 1 more");
    expect(lines[1].startsWith(" › ")).toBe(true);
    expect(pointed(lines)).toHaveLength(1);
  });

  it("enter opens the agent view from the panel and deselects", () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.host.pressEmptyLeft();

    expect(panel.key("enter")).toBe("consumed");
    expect(panel.open).toHaveBeenCalledWith(record.id, { from: "panel" });
    expect(pointed(panel.lines())).toEqual([]);
    expect(panel.host.editorCapture).toBeUndefined();
  });

  it("x stops a running agent through the runner and clears a done row for good", () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.running(record.id);
    panel.host.pressEmptyLeft();

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

  it("x on a done row clears it and keeps the selection on the next row", () => {
    const panel = setup();
    const done = panel.newAgent({ description: "finished" });

    panel.registry.close(done.id, { state: "done" });
    panel.running(panel.newAgent({ description: "second" }).id);
    panel.host.pressEmptyLeft();

    expect(panel.type("x")).toBe("consumed");

    const lines = panel.lines();

    expect(lines.join("\n")).not.toContain("finished");
    expect(pointed(lines)).toEqual([expect.stringContaining("second")]);
    expect(lines).toContain(HINT);
    expect(panel.host.editorCapture).toBeDefined();
  });

  it("x on the last row, a done one, moves the selection to the previous row", () => {
    const panel = setup();

    panel.running(panel.newAgent({ description: "first" }).id);

    const done = panel.newAgent({ description: "finished" });

    panel.registry.close(done.id, { state: "done" });
    panel.host.pressEmptyLeft();
    panel.key("down");
    panel.type("x");

    expect(pointed(panel.lines())).toEqual([expect.stringContaining("first")]);
    expect(panel.host.editorCapture).toBeDefined();
  });

  it("releases the capture when the selected row lingered out before the next tick", () => {
    const panel = setup();
    const record = panel.newAgent({ description: "finished" });

    panel.registry.close(record.id, { state: "done" });
    panel.host.pressEmptyLeft();
    vi.setSystemTime(Date.now() + 10_000);

    expect(panel.key("down")).toBe("release");
    expect(panel.host.editorCapture).toBeUndefined();
  });

  it("reports a rejected stop", async () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.stop.mockRejectedValueOnce(new Error("runner gone"));
    panel.running(record.id);
    panel.host.pressEmptyLeft();
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
    panel.host.pressEmptyLeft();

    expect(panel.type("a")).toBe("release");

    const lines = panel.lines();

    expect(pointed(lines)).toEqual([]);
    expect(lines).not.toContain(HINT);
    expect(panel.host.editorCapture).toBeUndefined();
  });

  it("left on a selected row is consumed and does not move the selection", () => {
    const panel = setup();

    Array.from({ length: 3 }, () => panel.newAgent());
    panel.host.pressEmptyLeft();
    panel.key("down");

    const before = panel.lines();

    expect(panel.key("left")).toBe("consumed");
    expect(panel.lines()).toEqual(before);
    expect(pointed(panel.lines())).toHaveLength(1);
    expect(panel.host.editorCapture).toBeDefined();
  });

  it("right on a selected row deselects and releases the capture", () => {
    const panel = setup();

    panel.newAgent();
    panel.host.pressEmptyLeft();

    expect(panel.key("right")).toBe("release");
    expect(pointed(panel.lines())).toEqual([]);
    expect(panel.host.editorCapture).toBeUndefined();
  });

  it("esc deselects without reaching the editor", () => {
    const panel = setup();

    panel.newAgent();
    panel.host.pressEmptyLeft();

    expect(panel.key("escape")).toBe("consumed");
    expect(pointed(panel.lines())).toEqual([]);
  });

  it("deselects and releases the capture when the selected row leaves", () => {
    const panel = setup();
    const first = panel.newAgent({ description: "first" });

    panel.running(first.id);
    panel.registry.close(first.id, { state: "done" });
    panel.host.pressEmptyLeft();
    panel.running(panel.newAgent({ description: "second" }).id);

    expect(pointed(panel.lines())).toEqual([expect.stringContaining("first")]);

    vi.advanceTimersByTime(10_001);

    expect(panel.host.editorCapture).toBeUndefined();
    expect(pointed(panel.lines())).toEqual([]);
    expect(panel.lines().join("\n")).toContain("second");
  });

  it("keeps the window in place when the selection clears", () => {
    const panel = setup();

    Array.from({ length: 7 }, () => panel.running(panel.newAgent().id));
    panel.host.pressEmptyLeft();
    Array.from({ length: 6 }, () => panel.key("down"));

    expect(panel.lines()[0]).toBe(" ↑ 2 more");

    panel.key("escape");

    const after = panel.lines();

    expect(pointed(after)).toEqual([]);
    expect(after).not.toContain(HINT);
    expect(after[0]).toBe(" ↑ 2 more");

    panel.host.pressEmptyLeft();

    const reselected = panel.lines();

    expect(reselected[0].startsWith(" › ")).toBe(true);

    panel.type("a");

    expect(panel.lines()[0]).toMatch(/^ [^›]/);
    expect(panel.lines()[0]).not.toContain("›");
    expect(panel.lines().at(-2)).toBe(" ↓ 2 more");
  });

  it("ticks every 100 ms while a row runs, every second with only queued rows, and never when empty", () => {
    const empty = setup();

    expect(vi.getTimerCount()).toBe(0);
    expect(empty.widget()).toBeUndefined();

    const panel = setup();
    const record = panel.newAgent();

    panel.lines();

    const queuedStart = panel.host.widgetRefreshes;

    vi.advanceTimersByTime(1_000);

    expect(panel.host.widgetRefreshes).toBe(queuedStart);

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

  it("ticks once a second with only queued rows", () => {
    const panel = setup();

    panel.newAgent();

    const list = vi.spyOn(panel.registry, "list");

    vi.advanceTimersByTime(999);

    expect(list).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(list).toHaveBeenCalled();
  });

  it("skips the redraw when the panel output is unchanged", () => {
    const panel = setup();
    const record = panel.newAgent();
    const first = panel.lines();
    const start = panel.host.widgetRefreshes;

    panel.registry.update(record.id, { tokens: 500 });

    expect(panel.host.widgetRefreshes).toBe(start);
    expect(panel.lines()).toBe(first);

    panel.running(record.id);

    expect(panel.host.widgetRefreshes).toBe(start + 1);
  });

  it("stops redrawing on ticks once every row is closed and unchanged", () => {
    const panel = setup();
    const first = panel.newAgent();
    const second = panel.newAgent();

    panel.running(first.id);
    vi.advanceTimersByTime(3_000);

    const whileOpen = panel.host.widgetRefreshes;

    expect(whileOpen).toBeGreaterThanOrEqual(3);

    panel.registry.close(first.id, { state: "done" });
    panel.registry.close(second.id, { state: "done" });

    const afterClose = panel.host.widgetRefreshes;

    vi.advanceTimersByTime(5_000);

    expect(panel.host.widgetRefreshes).toBe(afterClose);

    panel.host.pressEmptyLeft();

    const selected = panel.host.widgetRefreshes;

    panel.key("down");

    expect(panel.host.widgetRefreshes).toBe(selected + 1);
  });

  it("reuses the closed-row cache across renders", () => {
    const panel = setup();
    const record = panel.newAgent();
    let calls = 0;
    const counting: ThemeLike = {
      fg: (_token, text) => {
        calls += 1;
        return text;
      },
      bold: (text) => {
        calls += 1;
        return text;
      },
    };

    panel.registry.close(record.id, { state: "done" });
    panel.lines(80, counting);

    const before = calls;

    panel.lines(80, counting);

    expect(calls).toBe(before);
  });

  it("degrades without agent-view and run-agent", () => {
    const panel = setup({ services: false });
    const run = panel.newAgent({ description: "busy" });
    const done = panel.newAgent({ description: "finished" });

    panel.running(run.id);
    panel.registry.close(done.id, { state: "done" });
    panel.host.pressEmptyLeft();

    expect(panel.lines().at(-2)).toBe(" esc to deselect");
    expect(panel.key("enter")).toBe("consumed");

    panel.host.pressEmptyLeft();

    expect(panel.type("x")).toBe("consumed");
    expect(panel.registry.get(run.id)?.state).toBe("running");

    panel.key("down");

    expect(panel.lines().at(-2)).toBe(" x to clear · esc to deselect");

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

    const { services } = startPlugins(host, createFakeRuntime(), [agentRegistryPlugin, agentPanelPlugin]);

    services.require("registry").create({
      agent: "explorer",
      description: "look around",
      callerId: "main",
      depth: 2,
      batchId: "b-1",
      dir: join(root, "agents"),
      contextLimit: 100_000,
    });

    expect(host.pressEmptyLeft()).toBe(false);
    expect(host.widgets.get(WIDGET)?.(80, plainTheme)).toHaveLength(2);
  });

  it("removes the widget, the capture and the status on disable", async () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.running(record.id);
    panel.host.pressEmptyLeft();
    await panel.manager.disableAll();

    expect(panel.widget()).toBeUndefined();
    expect(panel.host.editorCapture).toBeUndefined();
    expect(panel.host.statuses.get(STATUS)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("footer status", () => {
  it("shows N agents while any record is open", () => {
    const panel = setup();
    const first = panel.newAgent();

    expect(panel.host.statuses.get(STATUS)).toBe("<accent>1 agent");

    panel.newAgent();

    expect(panel.host.statuses.get(STATUS)).toBe("<accent>2 agents");

    panel.registry.close(first.id, { state: "done" });

    expect(panel.host.statuses.get(STATUS)).toBe("<accent>1 agent");
  });

  it("shows the /agents hint for agentsHintMs after the last agent closes, then nothing", () => {
    const panel = setup();
    const record = panel.newAgent();

    panel.registry.close(record.id, { state: "done" });

    expect(panel.host.statuses.get(STATUS)).toBe("<dim>/agents to see agents");

    vi.advanceTimersByTime(29_999);

    expect(panel.host.statuses.get(STATUS)).toBe("<dim>/agents to see agents");

    vi.advanceTimersByTime(1);

    expect(panel.host.statuses.get(STATUS)).toBeUndefined();
  });

  it("reads agentsHintMs from the settings", () => {
    const panel = setup({ settings: { agentsHintMs: 5_000 } });

    panel.registry.close(panel.newAgent().id, { state: "done" });
    vi.advanceTimersByTime(4_999);

    expect(panel.host.statuses.get(STATUS)).toBe("<dim>/agents to see agents");

    vi.advanceTimersByTime(1);

    expect(panel.host.statuses.get(STATUS)).toBeUndefined();
  });

  it("replaces the hint with the count when a new agent starts", () => {
    const panel = setup();

    panel.registry.close(panel.newAgent().id, { state: "done" });
    vi.advanceTimersByTime(5_000);
    panel.newAgent();

    expect(panel.host.statuses.get(STATUS)).toBe("<accent>1 agent");

    vi.advanceTimersByTime(30_000);

    expect(panel.host.statuses.get(STATUS)).toBe("<accent>1 agent");
  });

  it("counts nested agents", () => {
    const panel = setup();
    const parent = panel.newAgent();

    panel.newAgent({ callerId: parent.id, depth: 3 });

    expect(panel.host.statuses.get(STATUS)).toBe("<accent>2 agents");
  });

  it("sets no status before any agent exists", () => {
    const panel = setup();

    expect(panel.host.statuses.has(STATUS)).toBe(false);
  });
});
