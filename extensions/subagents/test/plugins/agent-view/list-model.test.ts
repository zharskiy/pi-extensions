import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../../../src/model/types.ts";
import {
  listSections,
  MAX_CLOSED_ROOTS,
  visibleRecords,
} from "../../../src/plugins/agent-view/list-model.ts";
import { agentRecord } from "../../helpers/records.ts";

const NOW = 1_000_000;

const done = (id: string, endedAt: number, patch: Partial<AgentRecord> = {}) =>
  agentRecord({ id, state: "done", endedAt, ...patch });

const visible = (records: AgentRecord[]) => visibleRecords(records, new Set());

const sectionRows = (records: AgentRecord[]) =>
  listSections(records).map((section) => ({
    title: section.title,
    rows: section.rows.map((row) => `${row.depth}:${row.record.id}`),
  }));

describe("list model", () => {
  it("splits Running and Finished by the state of the root", () => {
    const records = [
      agentRecord({ id: "a", createdAt: 1 }),
      agentRecord({ id: "a1", callerId: "a", createdAt: 2 }),
      done("a2", NOW - 1_000, { callerId: "a", createdAt: 3 }),
      done("r", NOW - 1_000, { createdAt: 4 }),
      agentRecord({ id: "r1", callerId: "r", createdAt: 5 }),
    ];

    expect(sectionRows(visible(records))).toEqual([
      { title: "Running", rows: ["0:a", "1:a1", "1:a2", "0:r1"] },
      { title: "Finished (1)", rows: ["0:r"] },
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
    expect(rows.map((row) => row.first)).toEqual([true, true, false, true, false]);
  });

  it("orders Finished roots by newest endedAt first with their descendants under them and counts roots", () => {
    const records = [done("r", NOW - 20), done("s", NOW - 10), done("r1", NOW - 30, { callerId: "r" })];
    const sections = listSections(visible(records));

    expect(sections.map((section) => section.title)).toEqual(["Finished (2)"]);
    expect(sections[0]?.rows.map((row) => `${row.depth}:${row.record.id}`)).toEqual(["0:s", "0:r", "1:r1"]);
  });

  it("keeps closed agents however long ago they ended", () => {
    const records = [done("r", 0), done("r1", 0, { callerId: "r" }), agentRecord({ id: "a" })];

    expect(sectionRows(visible(records))).toEqual([
      { title: "Running", rows: ["0:a"] },
      { title: "Finished (1)", rows: ["0:r", "1:r1"] },
    ]);
  });

  it("hides cleared closed rows", () => {
    const records = [done("r", NOW - 10), done("r1", NOW - 20, { callerId: "r" }), done("s", NOW - 5)];

    expect(visibleRecords(records, new Set(["r", "r1"])).map((record) => record.id)).toEqual(["s"]);
  });

  it("caps Completed roots, dropping the oldest with their subtrees and chains", () => {
    const roots = Array.from({ length: MAX_CLOSED_ROOTS }, (_, index) => done(`k${index}`, NOW - index));
    const old = [
      done("old-1", 1, { successorId: "old-2", state: "handoff" }),
      done("old-2", 2, { predecessorId: "old-1", chainIndex: 2 }),
      done("old-child", 1, { callerId: "old-2" }),
      done("older", 0),
    ];
    const ids = visible([...old, ...roots, agentRecord({ id: "a" })]).map((record) => record.id);

    expect(ids).toHaveLength(MAX_CLOSED_ROOTS + 1);
    expect(ids).toContain("a");
    expect(ids).toContain(`k${MAX_CLOSED_ROOTS - 1}`);
    expect(ids.filter((id) => id.startsWith("old"))).toEqual([]);
  });

  it("counts only uncleared roots toward the cap", () => {
    const roots = Array.from({ length: MAX_CLOSED_ROOTS }, (_, index) => done(`k${index}`, NOW - index));
    const ids = visibleRecords([...roots, done("old", 0)], new Set(["k0"])).map((record) => record.id);

    expect(ids).toHaveLength(MAX_CLOSED_ROOTS);
    expect(ids).toContain("old");
    expect(ids).not.toContain("k0");
  });

  it("keeps a closed chain whole with its children while it is within the cap", () => {
    const records = [
      done("c-1", 5, { successorId: "c-2", state: "handoff" }),
      done("c-2", 6, { predecessorId: "c-1", chainIndex: 2 }),
      done("c-child", 4, { callerId: "c-2" }),
    ];

    expect(new Set(visible(records).map((record) => record.id))).toEqual(new Set(["c-1", "c-2", "c-child"]));
  });

  it("computes a large registry in a single pass", () => {
    const tree = (prefix: string, closed: boolean, endedAt: number) => {
      const state = closed ? "done" : "running";
      const root = agentRecord({
        id: prefix,
        state,
        endedAt: closed ? endedAt : undefined,
        createdAt: endedAt,
      });
      const nested = Array.from({ length: 9 }, (_, index) =>
        done(`${prefix}-${index}`, endedAt, { callerId: index === 0 ? prefix : `${prefix}-${index - 1}` }),
      );

      return [root, ...nested];
    };
    const records = [
      ...Array.from({ length: 400 }, (_, index) => tree(`c${index}`, true, NOW - index)),
      ...Array.from({ length: 30 }, (_, index) => tree(`o${index}`, false, NOW + index)),
    ].flat();
    const reads = { predecessorId: 0, successorId: 0 };

    const counted = (key: "predecessorId" | "successorId") => (record: AgentRecord) => {
      Object.defineProperty(record, key, {
        get: () => {
          reads[key] += 1;

          return undefined;
        },
      });
    };

    records.forEach(counted("predecessorId"));
    records.forEach(counted("successorId"));

    const sections = listSections(visibleRecords(records, new Set()));

    expect(records.length).toBeGreaterThan(4_000);
    expect(sections.map((section) => section.title)).toEqual(["Running", `Finished (${MAX_CLOSED_ROOTS})`]);
    expect(sections[1]?.rows).toHaveLength(MAX_CLOSED_ROOTS * 10);
    expect(reads.predecessorId).toBeLessThanOrEqual(records.length * 4);
    expect(reads.successorId).toBeLessThanOrEqual(records.length * 4);
  });
});
