import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeLike } from "../../../../../core/adapter/contract.ts";
import { initRenderTheme } from "../../../../../core/test/adapter/render-theme.ts";
import { flush, plainTheme } from "../../../../../core/test/helpers/fakes.ts";
import type { AgentRecord, NewAgent } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentViewPlugin } from "../../../src/plugins/agent-view/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import { createHarness, spawnAgents } from "../../helpers/harness.ts";
import {
  char,
  disposeOverlays,
  key,
  openLastOverlay,
  plain,
  recordingTheme,
  selectedRow,
} from "../../helpers/overlay.ts";
import { newAgentInput } from "../../helpers/records.ts";

initRenderTheme();

const NOW = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  disposeOverlays();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const setup = () => {
  const harness = createHarness([
    agentRegistryPlugin,
    agentDefinitionsPlugin,
    runAgentPlugin,
    agentViewPlugin,
  ]);
  const registry = harness.services.require("registry");

  const create = (patch: Partial<NewAgent> & { state?: AgentRecord["state"]; createdAt?: number } = {}) => {
    const { state = "running", createdAt, ...input } = patch;
    const record = registry.create(newAgentInput(harness.root, input));

    registry.update(record.id, { state, ...(createdAt === undefined ? {} : { createdAt }) });

    return record;
  };

  const finish = (id: string, endedAt = NOW, state: AgentRecord["state"] = "done") => {
    registry.close(id, { state });
    registry.update(id, { endedAt });
  };

  const openList = async (rows = 40, width = 100, theme?: ThemeLike) => {
    await harness.host.runCommand("agents", "");

    const { view, state, lines } = openLastOverlay(harness.host, rows, theme);

    return { view, state, lines: () => lines(width) };
  };

  const spawn = (count: number) => spawnAgents(harness, count);

  return { ...harness, registry, create, finish, openList, spawn };
};

describe("agents list", () => {
  it("opens from /agents without an id and shows the empty state", async () => {
    const { lines } = await setup().openList();

    expect(lines()[0]).toBe("");
    expect(lines()[1]).toBe(" Agents");
    expect(lines()).toContain(" No agents running");
    expect(lines().at(-2)).toBe(" → to main");
    expect(lines().at(-1)).toBe("");
  });

  it("keeps Agents bold and the subtitle dim when the title is cut", async () => {
    const harness = setup();

    harness.create({ createdAt: 1 });
    harness.create({ createdAt: 2 });

    const { lines } = await harness.openList(40, 14, recordingTheme);

    expect(lines()[1]).toBe(" <b>Agents</b><dim> · 2 …</>");
  });

  it("shows the sections, headers, rows and subtitle", async () => {
    const harness = setup();
    const root = harness.create({ description: "map the auth module", createdAt: 1 });
    const child = harness.create({ callerId: root.id, description: "find callers", createdAt: 2 });
    const doneChild = harness.create({ callerId: root.id, description: "find parseDate", createdAt: 3 });
    const finished = harness.create({ agent: "reviewer", description: "review the diff", createdAt: 4 });
    const finishedChild = harness.create({
      callerId: finished.id,
      description: "collect files",
      createdAt: 5,
    });

    harness.finish(doneChild.id, NOW - 45_000);
    harness.finish(finishedChild.id, NOW - 40_000);
    harness.finish(finished.id, NOW - 1_000);

    const { lines } = await harness.openList();
    const body = lines().slice(0, 12);

    expect(body.slice(0, 4)).toEqual(["", " Agents · 2 running · 3 done", "", " Running"]);
    expect(body[4]).toMatch(/^ › ⠋ explorer \(\+1\) +map the auth module/);
    expect(body[5]).toMatch(/^ ├─ ⠋ explorer +find callers/);
    expect(body[6]).toMatch(/^ └─ ✓ explorer +find parseDate +done · \d+m? ?\d+s$/);
    expect(body[7]).toBe("");
    expect(body[8]).toBe(" Completed (1)");
    expect(body[9]).toMatch(/^ ✓ reviewer +review the diff +done · /);
    expect(body[10]).toMatch(/^ └─ ✓ explorer +collect files +done · /);
    expect(new Set([6, 9, 10].map((index) => body[index].indexOf("done · "))).size).toBe(1);
    expect(lines().join("\n")).not.toContain(child.id);
  });

  it("moves over rows, skipping headers, clamped at both ends", async () => {
    const harness = setup();
    harness.create({ description: "first", createdAt: 1 });

    const closed = harness.create({ description: "closed one", createdAt: 2 });

    harness.finish(closed.id, NOW - 1_000);

    const { view, lines } = await harness.openList();

    expect(selectedRow(lines())).toContain("first");
    expect(lines().at(-2)).toBe(" ↑/↓ to select · enter to view · x to stop · X to stop all · → to main");

    view.handleKey(key("down"));

    expect(selectedRow(lines())).toContain("closed one");
    expect(lines().at(-2)).toBe(" ↑/↓ to select · enter to view · x to clear · X to stop all · → to main");

    view.handleKey(key("down"));

    expect(selectedRow(lines())).toContain("closed one");

    view.handleKey(key("up"));
    view.handleKey(key("up"));

    expect(selectedRow(lines())).toContain("first");
  });

  it("stops the selected agent with x and closes it with a second x", async () => {
    const harness = setup();
    const [record] = await harness.spawn(1);
    const { view, lines } = await harness.openList();

    expect(lines().at(-2)).toContain("x to stop");

    view.handleKey(char("x"));
    await flush();

    expect(harness.registry.get(record?.id ?? "")?.state).toBe("grace");
    expect(harness.runtime.child(record?.id ?? "").aborted).toBe(true);
    expect(lines().at(-2)).toContain("x to close now");

    view.handleKey(char("x"));
    await flush();

    expect(harness.registry.get(record?.id ?? "")?.state).toBe("stopped");
  });

  it("stops the running and queued agents, leaves a grace agent and clears the prompt on the second X within 3 s", async () => {
    const harness = setup();
    const running = harness.create({ description: "running" });
    const queued = harness.create({ description: "queued", state: "queued" });
    const grace = harness.create({ description: "grace", state: "grace" });
    const stop = vi.fn(async (id: string) => {
      const record = harness.registry.get(id);

      if (record?.state === "queued") {
        harness.registry.close(id, { state: "stopped" });
      } else {
        harness.registry.update(id, { state: "grace" });
      }

      return true;
    });

    harness.services.provide("runner", {
      stop,
      route: async () => ({ ok: true, delivery: "steer" }),
      abort: async () => {},
    });

    const { view, lines } = await harness.openList();

    view.handleKey(char("X"));

    expect(lines().at(-3)).toBe(" Press X again to stop all agents");
    expect(lines().at(-4)).toBe("");

    vi.advanceTimersByTime(2_000);
    view.handleKey(char("X"));
    await flush();

    expect(stop.mock.calls.map(([id]) => id).sort()).toEqual([running.id, queued.id].sort());
    expect(harness.registry.get(running.id)?.state).toBe("grace");
    expect(harness.registry.get(queued.id)?.state).toBe("stopped");
    expect(harness.registry.get(grace.id)?.state).toBe("grace");
    expect(lines()).not.toContain(" Press X again to stop all agents");
  });

  it("drops the confirmation after 3 s or on any other key", async () => {
    const harness = setup();
    const records = [harness.create({ description: "one", createdAt: 1 }), harness.create({ createdAt: 2 })];
    const states = () => records.map((record) => harness.registry.get(record.id)?.state);
    const { view, state, lines } = await harness.openList();
    const feedback = " Press X again to stop all agents";

    view.handleKey(char("X"));
    vi.advanceTimersByTime(3_001);

    expect(lines()).not.toContain(feedback);

    view.handleKey(char("X"));

    expect(lines()).toContain(feedback);
    expect(states()).toEqual(["running", "running"]);

    view.handleKey(key("down"));

    expect(lines()).not.toContain(feedback);
    expect(selectedRow(lines())).toContain("look around");
    expect(states()).toEqual(["running", "running"]);

    view.handleKey(char("X"));
    view.handleKey(key("escape"));
    await flush();

    expect(lines()).not.toContain(feedback);
    expect(states()).toEqual(["running", "running"]);
    expect(state.closed).toBe(true);
  });

  it("ignores / and other unbound keys", async () => {
    const harness = setup();

    harness.create();

    const { view, state, lines } = await harness.openList();
    const before = lines();

    ["/", "a", "y", "r", "c", "v"].forEach((value) => {
      view.handleKey(char(value));
    });
    view.handleKey(key("tab"));
    view.handleKey(key("space"));
    view.handleKey(key("toggleTools"));

    expect(lines()).toEqual(before);
    expect(state.closed).toBe(false);
  });

  it("keeps the selected row visible while moving through a long list", async () => {
    const harness = setup();

    Array.from({ length: 30 }).forEach((_, index) => {
      harness.create({ description: `job ${index}`, createdAt: index });
    });

    const { view, lines } = await harness.openList(12);

    expect(lines()[3]).toBe(" Running");

    Array.from({ length: 20 }).forEach(() => {
      view.handleKey(key("down"));
    });

    expect(selectedRow(lines())).toContain("job 20");

    view.handleKey(key("home"));

    expect(lines()[3]).toBe(" Running");
    expect(selectedRow(lines())).toContain("job 0");
  });

  it("pads every line and keeps the last column blank", async () => {
    const harness = setup();
    const root = harness.create({ description: "a description long enough to need cutting at any width" });

    harness.create({ callerId: root.id, description: "child" });

    const closed = harness.create({ description: "closed" });

    harness.finish(closed.id, NOW - 1_000);

    const { view } = await harness.openList(20);

    view.handleKey(char("X"));

    [80, 40].forEach((width) => {
      const lines = plain(view.render(width));
      const rows = lines.filter((line) => line.includes("explorer"));

      expect(lines[0]).toBe("");
      expect(lines.at(-4)).toBe("");
      expect(lines.at(-1)).toBe("");
      expect(lines.at(-3)).toBe(" Press X again to stop all agents");
      lines
        .filter((line) => line !== "")
        .forEach((line) => {
          expect(line).toMatch(/^ /);
          expect(plainTheme.width(line)).toBeLessThanOrEqual(width - 1);
        });
      rows.forEach((line) => {
        expect(line.slice(0, 1)).toBe(" ");
        expect(line.slice(line.startsWith(" › ") ? 3 : 1).slice(0, 1)).toMatch(/[⠋✓├└]/);
      });
    });
  });

  it("clears a completed subtree with x on its root and a child alone with x on the child", async () => {
    const harness = setup();
    const running = harness.create({ description: "running root", createdAt: 1 });
    const closedChild = harness.create({ callerId: running.id, description: "closed child", createdAt: 2 });
    const root = harness.create({ description: "done root", createdAt: 3 });
    const rootChild = harness.create({ callerId: root.id, description: "done child", createdAt: 4 });

    harness.finish(closedChild.id, NOW - 1_000);
    harness.finish(rootChild.id, NOW - 1_000);
    harness.finish(root.id, NOW - 1_000);

    const { view, lines } = await harness.openList();

    view.handleKey(key("end"));
    view.handleKey(key("up"));

    expect(selectedRow(lines())).toContain("done root");

    view.handleKey(char("x"));

    expect(lines().join("\n")).not.toContain("done root");
    expect(lines().join("\n")).not.toContain("done child");
    expect(selectedRow(lines())).toContain("closed child");

    view.handleKey(char("x"));

    expect(lines().join("\n")).not.toContain("closed child");
    expect(lines().join("\n")).toContain("running root");
  });

  it("says No running agents for 2 s with only closed and grace agents and stops nothing", async () => {
    const harness = setup();
    const closed = harness.create();
    const grace = harness.create({ state: "grace" });
    const stop = vi.fn(async () => true);

    harness.finish(closed.id, NOW - 1_000);
    harness.services.provide("runner", {
      stop,
      route: async () => ({ ok: true, delivery: "steer" }),
      abort: async () => {},
    });

    const { view, lines } = await harness.openList();

    view.handleKey(char("X"));

    expect(lines().at(-3)).toBe(" No running agents");

    view.handleKey(char("X"));
    await flush();

    expect(lines().at(-3)).toBe(" No running agents");
    expect(stop).not.toHaveBeenCalled();
    expect(harness.registry.get(grace.id)?.state).toBe("grace");

    vi.advanceTimersByTime(2_000);

    expect(lines().at(-3)).toBe("");
  });

  it("clears its timers on dispose", async () => {
    const harness = setup();

    harness.create();

    const { view } = await harness.openList();

    view.handleKey(char("X"));
    view.dispose?.();

    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();

    const realSetTimeout = globalThis.setTimeout;
    const unref = vi.fn();

    vi.stubGlobal("setTimeout", (run: () => void, ms: number) =>
      Object.assign(realSetTimeout(run, ms), { unref }),
    );

    const { view: second } = await harness.openList();

    unref.mockClear();
    second.handleKey(char("X"));

    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("keeps a closed row for lingerMs, then drops it on the tick", async () => {
    const harness = setup();
    const closed = harness.create({ description: "short lived" });

    harness.finish(closed.id, NOW);

    const { lines } = await harness.openList();

    expect(lines().join("\n")).toContain("short lived");

    vi.advanceTimersByTime(29_000);

    expect(lines().join("\n")).toContain("short lived");

    vi.advanceTimersByTime(2_000);

    expect(lines().join("\n")).not.toContain("short lived");
    expect(lines()).toContain(" No agents running");
  });

  it("clears a closed row with x, selects the next row, and keeps it cleared after reopening /agents", async () => {
    const harness = setup();
    const first = harness.create({ description: "first done", createdAt: 1 });
    const second = harness.create({ description: "second done", createdAt: 2 });

    harness.finish(first.id, NOW - 1_000);
    harness.finish(second.id, NOW - 2_000);

    const { view, lines } = await harness.openList();

    expect(selectedRow(lines())).toContain("first done");

    view.handleKey(char("x"));

    expect(lines().join("\n")).not.toContain("first done");
    expect(selectedRow(lines())).toContain("second done");

    const reopened = await harness.openList();

    expect(reopened.lines().join("\n")).not.toContain("first done");
    expect(reopened.lines().join("\n")).toContain("second done");
  });

  it("moves the selection with PgDn, End and the wheel and keeps it visible", async () => {
    const harness = setup();

    Array.from({ length: 30 }).forEach((_, index) => {
      harness.create({ description: `job ${index}`, createdAt: index });
    });

    const { view, lines } = await harness.openList(12);
    const height = 12 - 5 - 1;

    view.handleKey(key("pageDown"));

    expect(selectedRow(lines())).toContain(`job ${height - 1}`);

    view.handleKey(key("end"));

    expect(selectedRow(lines())).toContain("job 29");

    view.handleWheel?.(-3);

    expect(selectedRow(lines())).toContain("job 26");

    view.handleKey(key("pageUp"));

    expect(selectedRow(lines())).toContain(`job ${26 - (height - 1)}`);
  });

  it("refreshes when an agent changes", async () => {
    const harness = setup();
    const { lines } = await harness.openList();

    expect(lines()).toContain(" No agents running");

    harness.create({ description: "late arrival" });
    vi.advanceTimersByTime(0);
    await flush();

    expect(lines().join("\n")).toContain("late arrival");
  });

  it("completes /agents with the listed ids only", async () => {
    const harness = setup();
    const open = harness.create({ description: "open" });
    const expired = harness.create({ description: "expired" });
    const cleared = harness.create({ description: "cleared", createdAt: -1 });

    harness.finish(expired.id, NOW - 60_000);
    harness.finish(cleared.id, NOW - 1_000);

    const { view } = await harness.openList();

    view.handleKey(key("down"));
    view.handleKey(char("x"));

    const command = harness.host.commands.get("agents");
    const values = (command?.complete?.("") ?? []).map((item) => item.value);

    expect(values).toEqual([open.id]);
    expect(command?.complete?.("zzz")).toEqual([]);
    expect((command?.complete?.("") ?? [])[0]?.label).toBe(`${open.id} · running · open`);
  });

  it("moves the selection to the next row when the selected row lingers out", async () => {
    const harness = setup();
    const root = harness.create({ description: "open root", createdAt: 1 });
    const child = harness.create({ callerId: root.id, description: "closed child", createdAt: 2 });
    const grandchild = harness.create({
      callerId: child.id,
      description: "lingering grandchild",
      createdAt: 3,
    });

    harness.create({ callerId: root.id, description: "open sibling", createdAt: 4 });
    harness.finish(grandchild.id, NOW - 29_500);
    harness.finish(child.id, NOW - 29_500);

    const { view, lines } = await harness.openList();

    view.handleKey(key("down"));
    view.handleKey(key("down"));

    expect(selectedRow(lines())).toContain("lingering grandchild");

    vi.advanceTimersByTime(1_000);

    expect(lines().join("\n")).not.toContain("lingering grandchild");
    expect(lines().join("\n")).toContain("closed child");
    expect(selectedRow(lines())).toContain("open sibling");
  });

  it("keeps a closed child under its open caller past lingerMs, and its own children for lingerMs", async () => {
    const harness = setup();
    const root = harness.create({ description: "open root", createdAt: 1 });
    const child = harness.create({ callerId: root.id, description: "old child", createdAt: 2 });
    const stale = harness.create({ callerId: child.id, description: "stale grandchild", createdAt: 3 });
    const recent = harness.create({ callerId: child.id, description: "recent grandchild", createdAt: 4 });

    harness.finish(stale.id, NOW - 60_000);
    harness.finish(recent.id, NOW - 1_000);
    harness.finish(child.id, NOW - 60_000);

    const { lines } = await harness.openList();
    const text = lines().join("\n");

    expect(lines().slice(1, 4)).toEqual([" Agents · 1 running · 2 done", "", " Running"]);
    expect(lines()[4]).toMatch(/^ › ⠋ explorer +open root/);
    expect(lines()[5]).toMatch(/^ └─ ✓ explorer +old child +done/);
    expect(lines()[6]).toMatch(/^ {4}└─ ✓ explorer +recent grandchild +done/);
    expect(text).not.toContain("stale grandchild");
    expect(text).not.toContain("Completed");
  });

  it("moves a closed subtree to Completed and lingers it from the root's endedAt", async () => {
    const harness = setup();
    const root = harness.create({ description: "done root", createdAt: 1 });
    const child = harness.create({ callerId: root.id, description: "early child", createdAt: 2 });

    harness.finish(child.id, NOW - 50_000);
    harness.finish(root.id, NOW - 10_000);

    const { lines } = await harness.openList();

    expect(lines().slice(3, 6)).toEqual([
      " Completed (1)",
      expect.stringMatching(/^ › ✓ explorer +done root +done/),
      expect.stringMatching(/^ └─ ✓ explorer +early child +done/),
    ]);

    vi.advanceTimersByTime(20_000);

    expect(lines()).toContain(" No agents running");
  });

  it("shows a chain as one row, its terminal, under the caller of its first link", async () => {
    const harness = setup();

    harness.create({ description: "other root", createdAt: 1 });

    const first = harness.create({ description: "chained job", createdAt: 2 });
    const second = harness.create({
      description: "chained job",
      chainIndex: 2,
      predecessorId: first.id,
      createdAt: 3,
    });

    harness.finish(first.id, NOW - 1_000, "handoff");
    harness.registry.update(first.id, { successorId: second.id });
    harness.create({ callerId: first.id, description: "child of the first link", createdAt: 4 });

    const { lines } = await harness.openList();
    const text = lines().join("\n");

    expect(lines()[1]).toBe(" Agents · 3 running");
    expect(lines()[4]).toMatch(/^ › ⠋ explorer +other root/);
    expect(lines()[5]).toMatch(/^ ⠋ explorer #2 \(\+1\) +chained job/);
    expect(lines()[6]).toMatch(/^ └─ ⠋ explorer +child of the first link/);
    expect(text.match(/chained job/g)).toHaveLength(1);
  });
});
