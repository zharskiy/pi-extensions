import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../../../src/model/types.ts";
import {
  clearTargets,
  listHint,
  listSections,
  subtitle,
  visibleRecords,
} from "../../../src/plugins/agent-view/list-model.ts";
import { agentRecord } from "../../helpers/records.ts";

const NOW = 1_000_000;

const LINGER = 30_000;

const done = (id: string, endedAt: number, patch: Partial<AgentRecord> = {}) =>
  agentRecord({ id, state: "done", endedAt, ...patch });

const ids = (records: AgentRecord[]) => records.map((record) => record.id).sort();

const visible = (records: AgentRecord[], cleared: string[] = []) =>
  visibleRecords(records, NOW, LINGER, new Set(cleared));

const sectionRows = (records: AgentRecord[]) =>
  listSections(records).map((section) => ({
    title: section.title,
    rows: section.rows.map((row) => `${row.depth}:${row.record.id}`),
  }));

describe("list model", () => {
  it("lists open records always and closed roots for lingerMs after endedAt", () => {
    const records = [
      agentRecord({ id: "open" }),
      done("fresh", NOW - 29_999),
      done("old", NOW - 30_000),
      done("cleared", NOW - 1_000),
    ];

    expect(ids(visible(records, ["cleared", "open"]))).toEqual(["fresh", "open"]);
  });

  it("keeps a closed child under its open caller past lingerMs", () => {
    const a = agentRecord({ id: "a" });
    const a1 = done("a1", NOW - 60_000, { callerId: "a" });

    expect(ids(visible([a, a1]))).toEqual(["a", "a1"]);
    expect(ids(visible([a, a1, done("a1x", NOW - 60_000, { callerId: "a1" })]))).toEqual(["a", "a1"]);

    const stale = done("a1", NOW - 60_000, { callerId: "a" });
    const recent = done("a1x", NOW - 1_000, { callerId: "a1" });

    expect(ids(visible([a, stale, recent]))).toEqual(["a", "a1", "a1x"]);
  });

  it("moves a closed subtree to Completed and lingers it from the root's endedAt", () => {
    const child = done("r1", NOW - 50_000, { callerId: "r" });
    const listed = visible([done("r", NOW - 10_000), child]);

    expect(sectionRows(listed)).toEqual([{ title: "Completed (1)", rows: ["0:r", "1:r1"] }]);
    expect(visible([done("r", NOW - 30_000), child])).toEqual([]);
  });

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

  it("counts the subtitle", () => {
    const records = [
      agentRecord({ id: "q", state: "queued" }),
      agentRecord({ id: "a" }),
      agentRecord({ id: "g", state: "grace" }),
      done("a1", NOW - 1_000, { callerId: "a" }),
      done("r", NOW - 1_000),
    ];

    expect(subtitle(visible(records))).toBe(" · 3 running · 2 done");
    expect(subtitle(visible(records.slice(0, 2)))).toBe(" · 2 running");
    expect(subtitle(visible([done("r", NOW - 1_000)]))).toBe(" · 1 done");
    expect(subtitle([])).toBe("");
  });

  it("clears a closed root with its subtree and a closed child alone", () => {
    const completed = [
      done("r", NOW - 1_000),
      done("r1", NOW - 1_000, { callerId: "r" }),
      done("r1x", NOW - 1_000, { callerId: "r1" }),
    ];

    expect(clearTargets("r", visible(completed))).toEqual(["r", "r1", "r1x"]);

    const running = [
      agentRecord({ id: "a" }),
      done("a1", NOW - 1_000, { callerId: "a" }),
      done("a1x", NOW - 1_000, { callerId: "a1" }),
      done("a2", NOW - 1_000, { callerId: "a" }),
    ];

    expect(clearTargets("a1", visible(running))).toEqual(["a1", "a1x"]);
    expect(clearTargets("a", visible(running))).toEqual([]);
  });

  it("writes the hint for the selected row", () => {
    expect(listHint(undefined)).toBe("esc to close");
    expect(listHint(agentRecord({ id: "a" }))).toBe(
      "↑/↓ to select · enter to view · x to stop · X to stop all · esc to close",
    );
    expect(listHint(agentRecord({ id: "q", state: "queued" }))).toContain("· x to stop ·");
    expect(listHint(agentRecord({ id: "g", state: "grace" }))).toBe(
      "↑/↓ to select · enter to view · x to close now · X to stop all · esc to close",
    );
    expect(listHint(done("d", 0))).toBe(
      "↑/↓ to select · enter to view · x to clear · X to stop all · esc to close",
    );
  });

  it("shows a chain as one row, its terminal, under the caller of its first link", () => {
    const records = [
      agentRecord({ id: "a", createdAt: 1 }),
      done("c1", NOW - 1_000, { callerId: "main", successorId: "c2", state: "handoff", createdAt: 2 }),
      agentRecord({ id: "c2", chainIndex: 2, predecessorId: "c1", createdAt: 3 }),
      agentRecord({ id: "c1x", callerId: "c1", createdAt: 4 }),
    ];

    expect(sectionRows(visible(records))).toEqual([{ title: "Running", rows: ["0:a", "0:c2", "1:c1x"] }]);
    expect(subtitle(visible(records))).toBe(" · 3 running");
  });
});
