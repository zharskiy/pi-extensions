import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeHost,
  createFakeRuntime,
  FAKE_FOOTER_KEY,
  plainTheme,
} from "../../../../../core/test/helpers/fakes.ts";
import type { ThemeLike } from "../../../../../pi-adapter/index.ts";
import type { Plugin } from "../../../src/model/plugin.ts";
import type { Settings } from "../../../src/model/settings.ts";
import type { AgentRunner, AgentState, NewAgent, ServiceMap } from "../../../src/model/types.ts";
import { agentPanelPlugin } from "../../../src/plugins/agent-panel/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { createHarness, startPlugins, tempDir } from "../../helpers/harness.ts";
import { selectedRow } from "../../helpers/overlay.ts";
import { newAgentInput } from "../../helpers/records.ts";

const WIDGET = "pi-subagents-agents";

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

    expect(panel.lines()).toEqual(["   ◌ explorer  look around  Queued", ""]);

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

  it("draws the running rows, the more marker and the key hints as one table", () => {
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
    expect(panel.lines().slice(-3)).toEqual(["   ↓ 3 more", HINT, ""]);
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
    expect(lines[1].startsWith("   ↳ ⠋ explorer")).toBe(true);
    expect(lines[1]).toContain("nested");
    expect(lines.slice(5)).toEqual(["   ↓ 3 more", ""]);
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

  it("moves the selection and scrolls the window", () => {
    const panel = setup();

    Array.from({ length: 7 }, () => panel.running(panel.newAgent().id));
    panel.host.pressEmptyDown();
    Array.from({ length: 5 }, () => panel.key("down"));

    const lines = panel.lines();

    expect(lines[0]).toBe("   ↑ 1 more");
    expect(selectedRow(lines)).toBe(lines[5]);
  });

  it("scrolls the window up to keep the selection visible", () => {
    const panel = setup();

    Array.from({ length: 7 }, () => panel.running(panel.newAgent().id));
    panel.host.pressEmptyDown();
    Array.from({ length: 6 }, () => panel.key("down"));
    Array.from({ length: 5 }, () => panel.key("up"));

    const lines = panel.lines();

    expect(lines[0]).toBe("   ↑ 1 more");
    expect(selectedRow(lines)).toBe(lines[1]);
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

    expect(panel.lines().at(-2)).toBe(" enter to view · x to close now · esc to deselect");
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

  it("keeps the window in place when the selection clears", () => {
    const panel = setup();

    Array.from({ length: 7 }, () => panel.running(panel.newAgent().id));
    panel.host.pressEmptyDown();
    Array.from({ length: 6 }, () => panel.key("down"));

    expect(panel.lines()[0]).toBe("   ↑ 2 more");

    panel.key("escape");

    const after = panel.lines();

    expect(selectedRow(after)).toBeUndefined();
    expect(after).not.toContain(HINT);
    expect(after[0]).toBe("   ↑ 2 more");

    panel.host.pressEmptyDown();

    const reselected = panel.lines();

    expect(selectedRow(reselected)).toBe(reselected[0]);

    panel.type("a");

    expect(panel.lines()[0]).toMatch(/^ {3}/);
    expect(panel.lines()[0]).not.toContain("›");
    expect(panel.lines().at(-2)).toBe("   ↓ 2 more");
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
    ["queued", " enter to view · x to stop · esc to deselect"],
    ["running", " enter to view · x to stop · esc to deselect"],
    ["grace", " enter to view · x to close now · esc to deselect"],
    ["done", " enter to view · x to clear · esc to deselect"],
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

  it("aligns the info column across the window and keeps it when the window scrolls", () => {
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
    expect(top[0]).toBe("   ".length + 2 + plainTheme.width("explorer") + 2 + 28 + 2);
  });

  it("puts the scroll markers in the glyph column and keeps every line within the width", () => {
    const panel = setup();

    Array.from({ length: 7 }, () => panel.running(panel.newAgent().id));
    panel.host.pressEmptyDown();
    Array.from({ length: 5 }, () => panel.key("down"));

    const lines = panel.lines();
    const glyphColumn = lines[1].indexOf("⠋");

    expect(glyphColumn).toBe(3);
    expect(lines[0].indexOf("↑")).toBe(glyphColumn);
    expect(lines[6].indexOf("↓")).toBe(glyphColumn);

    [80, 30].forEach((width) => {
      const drawn = panel.lines(width);

      drawn.forEach((line) => {
        expect(plainTheme.width(line)).toBeLessThanOrEqual(width);
      });
      expect(drawn.slice(0, -1).every((line) => line.startsWith(" "))).toBe(true);
      expect(drawn.at(-1)).toBe("");
    });

    expect(panel.lines(30).at(-2)).toBe(" enter to view · x to stop ...");
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

    services.require("registry").create(newAgentInput(join(root, "agents")));

    expect(host.pressEmptyDown()).toBe(false);
    expect(host.widgets.get(WIDGET)?.(80, plainTheme)).toHaveLength(2);
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

    const { manager } = startPlugins(host, createFakeRuntime(), [agentRegistryPlugin, agentPanelPlugin]);

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
