import { describe, expect, it } from "vitest";
import { carrySelection, isTerminal, nestPrefix, treeOrder, withLinks } from "../../src/components/tree.ts";
import type { AgentRecord } from "../../src/model/types.ts";
import { agentRecord } from "../support/agent-records.ts";

const byId = (rows: ReturnType<typeof treeOrder>, id: string) => rows.find((row) => row.record.id === id);

const indexOf = (records: AgentRecord[]) => new Map(records.map((record) => [record.id, record]));

describe("tree order", () => {
  it("orders callers first, children under their caller and siblings by createdAt", () => {
    const rows = treeOrder([
      agentRecord({ id: "a", createdAt: 10 }),
      agentRecord({ id: "b", createdAt: 5 }),
      agentRecord({ id: "c", callerId: "a", createdAt: 7 }),
      agentRecord({ id: "d", callerId: "a", createdAt: 6 }),
    ]);

    expect(rows.map((row) => row.record.id)).toEqual(["b", "a", "d", "c"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 0, 1, 1]);
    expect(rows.map((row) => row.first)).toEqual([true, false, true, false]);
  });

  it("prefixes the first child with the child mark and later siblings and deeper levels with spaces", () => {
    const rows = treeOrder([
      agentRecord({ id: "a", createdAt: 1 }),
      agentRecord({ id: "a1", callerId: "a", createdAt: 2 }),
      agentRecord({ id: "a2", callerId: "a", createdAt: 3 }),
      agentRecord({ id: "a1x", callerId: "a1", createdAt: 4 }),
      agentRecord({ id: "a1y", callerId: "a1", createdAt: 5 }),
    ]);

    expect(rows.map((row) => [row.record.id, nestPrefix(row)])).toEqual([
      ["a", ""],
      ["a1", "↳ "],
      ["a1x", "  ↳ "],
      ["a1y", "    "],
      ["a2", "  "],
    ]);
  });

  it("renders a child whose caller is absent at depth 0", () => {
    const rows = treeOrder([agentRecord({ id: "c", callerId: "gone" })]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ depth: 0, first: true });
  });

  it("collapses a chain to its terminal at the first link's position", () => {
    const rows = treeOrder([
      agentRecord({ id: "a", createdAt: 1, state: "handoff", successorId: "a2" }),
      agentRecord({ id: "b", createdAt: 2 }),
      agentRecord({ id: "a2", createdAt: 9, predecessorId: "a", chainIndex: 2 }),
    ]);

    expect(rows.map((row) => row.record.id)).toEqual(["a2", "b"]);
    expect(rows[0].depth).toBe(0);
  });

  it("attaches children of any chain link to the chain row", () => {
    const chain = [
      agentRecord({ id: "a", createdAt: 1, state: "handoff", successorId: "a2" }),
      agentRecord({ id: "b", createdAt: 2 }),
      agentRecord({ id: "a2", createdAt: 9, predecessorId: "a", chainIndex: 2 }),
    ];
    const running = treeOrder([...chain, agentRecord({ id: "k", callerId: "a", createdAt: 3 })]);

    expect(running.map((row) => row.record.id)).toEqual(["a2", "k", "b"]);
    expect(byId(running, "k")?.depth).toBe(1);
    expect(byId(running, "a2")?.openDescendants).toBe(1);

    const finished = treeOrder([
      ...chain,
      agentRecord({ id: "k", callerId: "a", createdAt: 3, state: "done" }),
    ]);

    expect(byId(finished, "a2")?.openDescendants).toBe(0);
  });

  it("shows a successor and its predecessor once while the predecessor has no successorId yet", () => {
    const records = [
      agentRecord({ id: "a", createdAt: 1, state: "handoff" }),
      agentRecord({ id: "a2", createdAt: 9, predecessorId: "a", chainIndex: 2 }),
    ];
    const index = indexOf(records);
    const terminals = records.filter((record) => isTerminal(record, index));

    expect(terminals.map((record) => record.id)).toEqual(["a", "a2"]);
    expect(withLinks(terminals, index).map((record) => record.id)).toEqual(["a", "a2"]);
    expect(treeOrder(withLinks(terminals, index)).map((row) => row.record.id)).toEqual(["a", "a2"]);
  });

  it("adds the earlier links of a chain once behind the listed records", () => {
    const records = [
      agentRecord({ id: "a", createdAt: 1, state: "handoff", successorId: "a2" }),
      agentRecord({
        id: "a2",
        createdAt: 5,
        state: "handoff",
        predecessorId: "a",
        successorId: "a3",
        chainIndex: 2,
      }),
      agentRecord({ id: "a3", createdAt: 9, predecessorId: "a2", chainIndex: 3 }),
      agentRecord({ id: "b", createdAt: 2 }),
    ];
    const index = indexOf(records);
    const terminals = records.filter((record) => isTerminal(record, index));

    expect(terminals.map((record) => record.id)).toEqual(["a3", "b"]);
    expect(withLinks(terminals, index).map((record) => record.id)).toEqual(["a3", "b", "a", "a2"]);
    expect(treeOrder(withLinks(terminals, index)).map((row) => row.record.id)).toEqual(["a3", "b"]);
  });

  it("counts open descendants over the whole subtree", () => {
    const rows = treeOrder([
      agentRecord({ id: "a", createdAt: 1 }),
      agentRecord({ id: "a1", callerId: "a", createdAt: 2, state: "done" }),
      agentRecord({ id: "a1x", callerId: "a1", createdAt: 3 }),
    ]);

    expect(byId(rows, "a")?.openDescendants).toBe(1);
    expect(byId(rows, "a1")?.openDescendants).toBe(1);
  });

  it("honours a roots predicate", () => {
    const rows = treeOrder(
      [agentRecord({ id: "a", createdAt: 1 }), agentRecord({ id: "a1", callerId: "a", createdAt: 2 })],
      (record) => record.id === "a1",
    );

    expect(rows.map((row) => [row.record.id, row.depth])).toEqual([
      ["a", 0],
      ["a1", 0],
    ]);
    expect(byId(rows, "a")?.openDescendants).toBe(0);
  });

  it("returns an empty list for no records", () => {
    expect(treeOrder([])).toEqual([]);
  });
});

describe("selection", () => {
  it("carries the selection to the next row, else the previous, else none", () => {
    expect(carrySelection(["a", "b", "c"], ["a", "b", "c"], "b")).toBe("b");
    expect(carrySelection(["a", "b", "c"], ["a", "c"], "b")).toBe("c");
    expect(carrySelection(["a", "b", "c"], ["a"], "c")).toBe("a");
    expect(carrySelection(["a"], [], "a")).toBeUndefined();
    expect(carrySelection([], ["a"], undefined)).toBeUndefined();
  });
});
