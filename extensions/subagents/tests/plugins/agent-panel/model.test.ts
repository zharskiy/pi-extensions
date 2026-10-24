import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../../../core/model/types.ts";
import { panelRows } from "../../../src/plugins/agent-panel/model.ts";
import { agentRecord } from "../../support/agent-records.ts";

const settings = { doneLingerMs: 10_000, failedLingerMs: 30_000 };

const ids = (rows: { record: AgentRecord }[]) => rows.map((row) => row.record.id);

describe("panel rows", () => {
  it("hides a cleared row for good", () => {
    const records = [
      agentRecord({ id: "f", state: "failed", endedAt: 0 }),
      agentRecord({ id: "d", state: "done", endedAt: 0 }),
      agentRecord({ id: "r", createdAt: 1 }),
    ];
    const cleared = new Set(["f", "d"]);

    expect(ids(panelRows(records, 0, settings, cleared))).toEqual(["r"]);
    expect(ids(panelRows(records, 29_999, settings, cleared))).toEqual(["r"]);
  });

  it("anchors a chain at the first link even after the link lingered out", () => {
    const records = [
      agentRecord({ id: "a", state: "handoff", endedAt: 0, successorId: "a2" }),
      agentRecord({ id: "b", createdAt: 5 }),
      agentRecord({ id: "a2", createdAt: 100, predecessorId: "a", chainIndex: 2 }),
    ];

    expect(ids(panelRows(records, 40_000, settings, new Set()))).toEqual(["a2", "b"]);
  });

  it("never shows a handed-off link after its successor left", () => {
    const records = [
      agentRecord({ id: "a", state: "handoff", endedAt: 0, successorId: "a2" }),
      agentRecord({ id: "a2", state: "done", endedAt: 5_000, predecessorId: "a", chainIndex: 2 }),
    ];

    expect(ids(panelRows(records, 16_000, settings, new Set()))).toEqual([]);
    expect(ids(panelRows(records, 6_000, settings, new Set(["a2"])))).toEqual([]);
  });
});
