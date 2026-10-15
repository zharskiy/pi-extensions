import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../../../src/model/types.ts";
import { listSections, visibleRecords } from "../../../src/plugins/agent-view/list-model.ts";
import { agentRecord } from "../../helpers/records.ts";

const NOW = 1_000_000;

const LINGER = 30_000;

const done = (id: string, endedAt: number, patch: Partial<AgentRecord> = {}) =>
  agentRecord({ id, state: "done", endedAt, ...patch });

const visible = (records: AgentRecord[]) => visibleRecords(records, NOW, LINGER, new Set());

const sectionRows = (records: AgentRecord[]) =>
  listSections(records).map((section) => ({
    title: section.title,
    rows: section.rows.map((row) => `${row.depth}:${row.record.id}`),
  }));

describe("list model", () => {
  it("splits Running and Completed by the state of the root", () => {
    const records = [
      agentRecord({ id: "a", createdAt: 1 }),
      agentRecord({ id: "a1", callerId: "a", createdAt: 2 }),
      done("a2", NOW - 1_000, { callerId: "a", createdAt: 3 }),
      done("r", NOW - 1_000, { createdAt: 4 }),
      agentRecord({ id: "r1", callerId: "r", createdAt: 5 }),
    ];

    expect(sectionRows(visible(records))).toEqual([
      { title: "Running", rows: ["0:a", "1:a1", "1:a2", "0:r1"] },
      { title: "Completed (1)", rows: ["0:r"] },
    ]);
    expect(sectionRows(visible([agentRecord({ id: "a" })]))).toEqual([{ title: "Running", rows: ["0:a"] }]);
    expect(listSections([])).toEqual([]);
  });

  it("orders each section as a tree", () => {
    const records = [
      agentRecord({ id: "b", createdAt: 2 }),
      agentRecord({ id: "a", createdAt: 1 }),
      agentRecord({ id: "a2", callerId: "a", createdAt: 4 }),
      done("a1", NOW - 1_000, { callerId: "a", createdAt: 3 }),
      agentRecord({ id: "a2x", callerId: "a2", createdAt: 5 }),
    ];
    const [running] = listSections(visible(records));
    const rows = running?.rows ?? [];

    expect(rows.map((row) => `${row.depth}:${row.record.id}`)).toEqual([
      "0:a",
      "1:a1",
      "1:a2",
      "2:a2x",
      "0:b",
    ]);
    expect(rows.map((row) => row.openDescendants)).toEqual([2, 0, 1, 0, 0]);
    expect(rows.map((row) => row.last)).toEqual([false, false, true, true, true]);
  });

  it("orders Completed roots by newest endedAt first with their descendants under them and counts roots", () => {
    const records = [done("r", NOW - 20), done("s", NOW - 10), done("r1", NOW - 30, { callerId: "r" })];
    const sections = listSections(visible(records));

    expect(sections.map((section) => section.title)).toEqual(["Completed (2)"]);
    expect(sections[0]?.rows.map((row) => `${row.depth}:${row.record.id}`)).toEqual(["0:s", "0:r", "1:r1"]);
  });
});
