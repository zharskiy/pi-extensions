import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../../../core/adapter/contract.ts";
import { plainTheme } from "../../../../../core/test/helpers/fakes.ts";
import { renderRow } from "../../../src/components/agent-row.ts";
import { displayWidth } from "../../../src/components/format.ts";
import { treeOrder } from "../../../src/components/tree.ts";
import type { AgentRecord } from "../../../src/model/types.ts";
import {
  createClosedRowCache,
  createPanelState,
  hintText,
  isVisible,
  type PanelState,
  panelLines,
  panelRows,
  reconcile,
  selectedIndex,
  windowOf,
} from "../../../src/plugins/agent-panel/model.ts";
import { agentRecord } from "../../helpers/records.ts";

const settings = { doneLingerMs: 10_000, failedLingerMs: 30_000 };

const both = { view: true, stop: true };

const ids = (rows: { record: AgentRecord }[]) => rows.map((row) => row.record.id);

const sevenRoots = () =>
  treeOrder(Array.from({ length: 7 }, (_, index) => agentRecord({ id: `r${index}`, createdAt: index })));

const select = (rows: ReturnType<typeof sevenRoots>, state: PanelState, id: string | undefined) => {
  state.selectedId = id;
  reconcile(rows, state);

  return windowOf(rows, state);
};

describe("panel rows", () => {
  it("keeps open rows, done rows for doneLingerMs and other closed rows for failedLingerMs", () => {
    const records = [
      agentRecord({ id: "done", state: "done", endedAt: 0 }),
      agentRecord({ id: "failed", state: "failed", endedAt: 0 }),
      agentRecord({ id: "stopped", state: "stopped", endedAt: 0 }),
      agentRecord({ id: "running" }),
    ];
    const visibleAt = (now: number) =>
      records.filter((record) => isVisible(record, now, settings, new Set())).map((record) => record.id);

    expect(visibleAt(9_999)).toEqual(["done", "failed", "stopped", "running"]);
    expect(visibleAt(10_000)).toEqual(["failed", "stopped", "running"]);
    expect(visibleAt(30_000)).toEqual(["running"]);
  });

  it("hides a cleared row for good", () => {
    const failed = agentRecord({ id: "f", state: "failed", endedAt: 0 });

    expect(isVisible(failed, 0, settings, new Set(["f"]))).toBe(false);
    expect(isVisible(failed, 29_999, settings, new Set(["f"]))).toBe(false);
    expect(isVisible(agentRecord({ id: "d", state: "done", endedAt: 0 }), 0, settings, new Set(["d"]))).toBe(
      false,
    );
  });

  it("anchors a chain at the first link even after the link lingered out", () => {
    const records = [
      agentRecord({ id: "a", state: "handoff", endedAt: 0, successorId: "a2" }),
      agentRecord({ id: "b", createdAt: 5 }),
      agentRecord({ id: "a2", createdAt: 100, predecessorId: "a", chainIndex: 2 }),
    ];

    expect(ids(panelRows(records, 40_000, settings, new Set()))).toEqual(["a2", "b"]);
  });
});

describe("panel window", () => {
  it("windows seven rows around the selection", () => {
    const rows = sevenRoots();
    const state = createPanelState();

    expect(windowOf(rows, state)).toEqual({ start: 0, end: 5, above: 0, below: 2 });
    expect(select(rows, state, "r3")).toEqual({ start: 0, end: 5, above: 0, below: 2 });
    expect(select(rows, state, "r0")).toEqual({ start: 0, end: 5, above: 0, below: 2 });
    expect(select(rows, state, "r6")).toEqual({ start: 2, end: 7, above: 2, below: 0 });
    expect(select(rows, state, "r3")).toMatchObject({ start: 2, end: 7 });
  });

  it("renders markers and the hint around the window", () => {
    const rows = sevenRoots();
    const state = createPanelState();

    select(rows, state, "r6");

    const scrolled = panelLines(rows, state, 0, 80, plainTheme, renderRow, both);

    expect(scrolled[0]).toBe("   ↑ 2 more");
    expect(scrolled.slice(1, 6).map((line) => line.trimEnd())).toEqual(
      ["r2", "r3", "r4", "r5", "r6"].map((id) => expect.stringContaining(`work of ${id}`)),
    );
    expect(scrolled.slice(6)).toEqual([" enter to view · x to stop · esc to deselect", ""]);

    state.top = 0;
    select(rows, state, "r3");

    const top = panelLines(rows, state, 0, 80, plainTheme, renderRow, both);

    expect(top).toHaveLength(8);
    expect(top[0]).toContain("work of r0");
    expect(top.slice(5)).toEqual(["   ↓ 2 more", " enter to view · x to stop · esc to deselect", ""]);
  });

  it("puts the markers in the glyph column", () => {
    const rows = sevenRoots();
    const state = createPanelState();

    select(rows, state, "r3");
    state.top = 1;

    const lines = panelLines(rows, state, 0, 80, plainTheme, renderRow, both);
    const glyphColumn = lines[1].indexOf("⠋");

    expect(glyphColumn).toBe(3);
    expect(lines[0].startsWith("   ")).toBe(true);
    expect(lines[0].indexOf("↑")).toBe(glyphColumn);
    expect(lines[6].indexOf("↓")).toBe(glyphColumn);
  });

  it("ends every line before the last column", () => {
    const rows = sevenRoots();
    const state = createPanelState();

    select(rows, state, "r3");
    state.top = 1;

    [80, 30].forEach((width) => {
      const lines = panelLines(rows, state, 0, width, plainTheme, renderRow, both);

      lines.forEach((line, index) => {
        expect(displayWidth(line)).toBeLessThanOrEqual(width - 1);

        if (index < lines.length - 1) {
          expect(line.startsWith(" ")).toBe(true);
        }
      });
      expect(lines.at(-1)).toBe("");
    });

    expect(panelLines(rows, state, 0, 30, plainTheme, renderRow, both).at(-2)).toBe(
      " enter to view · x to stop ·…",
    );
  });

  it("clears a selection whose row left and keeps it when rows are added", () => {
    const rows = sevenRoots();
    const state = createPanelState();

    state.selectedId = "r3";

    expect(reconcile(rows.slice(4), state)).toEqual({ deselected: true });
    expect(state.selectedId).toBeUndefined();

    state.selectedId = "r3";

    const added = treeOrder([agentRecord({ id: "early", createdAt: -1 }), ...rows.map((row) => row.record)]);

    expect(reconcile(added, state)).toEqual({ deselected: false });
    expect(selectedIndex(added, state)).toBe(4);
  });

  it("keeps the window top when the selection clears", () => {
    const rows = sevenRoots();
    const state = createPanelState();

    select(rows, state, "r6");

    expect(state.top).toBe(2);
    expect(reconcile(rows.slice(0, 6), state)).toEqual({ deselected: true });
    expect(state.top).toBe(1);

    state.top = 2;
    state.selectedId = "r6";
    reconcile(rows, state);
    state.selectedId = undefined;
    reconcile(rows, state);

    expect(state.top).toBe(2);

    reconcile(rows.slice(0, 4), state);

    expect(state.top).toBe(0);
  });

  it("builds the hint per state and per available action", () => {
    const none = { view: false, stop: false };

    expect(hintText(agentRecord({ id: "a" }), both)).toBe("enter to view · x to stop · esc to deselect");
    expect(hintText(agentRecord({ id: "a", state: "queued" }), both)).toBe(
      "enter to view · x to stop · esc to deselect",
    );
    expect(hintText(agentRecord({ id: "a", state: "grace" }), both)).toBe(
      "enter to view · x to close now · esc to deselect",
    );
    expect(hintText(agentRecord({ id: "a", state: "done" }), both)).toBe(
      "enter to view · x to clear · esc to deselect",
    );
    expect(hintText(agentRecord({ id: "a" }), none)).toBe("esc to deselect");
    expect(hintText(agentRecord({ id: "a", state: "done" }), none)).toBe("x to clear · esc to deselect");
  });

  it("reuses a closed row until its record, width, theme, selection or tree shape changes", () => {
    let calls = 0;
    const counting = (): ThemeLike => ({
      fg: (_token, text) => {
        calls += 1;
        return text;
      },
      bold: (text) => {
        calls += 1;
        return text;
      },
    });
    const theme = counting();
    const cache = createClosedRowCache();
    const closed = { record: agentRecord({ id: "c", state: "done", endedAt: 1_000 }), depth: 0, last: true };
    const input = { ...closed, ancestorsContinue: [], openDescendants: 0, selected: false };
    const first = cache(input, 5_000, 80, theme, 8);
    const before = calls;

    expect(cache(input, 6_000, 80, theme, 8)).toBe(first);
    expect(calls).toBe(before);

    const changes = [
      () => cache({ ...input, record: { ...input.record, version: 1 } }, 6_000, 80, theme, 8),
      () => cache(input, 6_000, 60, theme, 8),
      () => cache(input, 6_000, 80, counting(), 8),
      () => cache({ ...input, selected: true }, 6_000, 80, theme, 8),
      () => cache({ ...input, last: false }, 6_000, 80, theme, 8),
    ];

    changes.forEach((change) => {
      const counted = calls;

      change();

      expect(calls).toBeGreaterThan(counted);
    });

    const open = { ...input, record: agentRecord({ id: "o" }) };

    cache(open, 6_000, 80, theme, 8);

    const counted = calls;

    cache(open, 6_000, 80, theme, 8);

    expect(calls).toBeGreaterThan(counted);
  });

  it("returns no lines without rows", () => {
    expect(panelLines([], createPanelState(), 0, 80, plainTheme, renderRow, both)).toEqual([]);
  });
});
