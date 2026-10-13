import { describe, expect, it } from "vitest";
import { treeOrder } from "../../src/components/tree.ts";
import type { AgentRecord, AgentState } from "../../src/model/types.ts";

type Fixture = {
  id: string;
  callerId?: string;
  createdAt?: number;
  state?: AgentState;
  successorId?: string;
  predecessorId?: string;
  chainIndex?: number;
};

const rec = ({ id, callerId = "main", createdAt = 0, state = "running", ...rest }: Fixture): AgentRecord => ({
  id,
  agent: "explorer",
  description: `work of ${id}`,
  callerId,
  depth: 2,
  batchId: "b-1",
  chainIndex: 1,
  state,
  createdAt,
  turns: 0,
  toolCalls: 0,
  tokens: 0,
  lastText: "",
  handoffPath: "/x/handoff.md",
  dir: "/x",
  contextLimit: 100_000,
  handoffRequested: false,
  version: 0,
  ...rest,
});

const byId = (rows: ReturnType<typeof treeOrder>, id: string) => rows.find((row) => row.record.id === id);

describe("tree order", () => {
  it("orders callers first, children under their caller and siblings by createdAt", () => {
    const rows = treeOrder([
      rec({ id: "a", createdAt: 10 }),
      rec({ id: "b", createdAt: 5 }),
      rec({ id: "c", callerId: "a", createdAt: 7 }),
      rec({ id: "d", callerId: "a", createdAt: 6 }),
    ]);

    expect(rows.map((row) => row.record.id)).toEqual(["b", "a", "d", "c"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 0, 1, 1]);
    expect(rows.map((row) => row.last)).toEqual([false, true, false, true]);
  });

  it("marks continuation per ancestor level", () => {
    const rows = treeOrder([
      rec({ id: "a", createdAt: 1 }),
      rec({ id: "b", createdAt: 2 }),
      rec({ id: "a1", callerId: "a", createdAt: 3 }),
      rec({ id: "a2", callerId: "a", createdAt: 4 }),
      rec({ id: "a1x", callerId: "a1", createdAt: 5 }),
      rec({ id: "a2x", callerId: "a2", createdAt: 6 }),
    ]);

    expect(byId(rows, "a1")?.ancestorsContinue).toEqual([]);
    expect(byId(rows, "a1x")?.ancestorsContinue).toEqual([true]);
    expect(byId(rows, "a2x")?.ancestorsContinue).toEqual([false]);
  });

  it("renders a child whose caller is absent at depth 0", () => {
    const rows = treeOrder([rec({ id: "c", callerId: "gone" })]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ depth: 0, ancestorsContinue: [] });
  });

  it("collapses a chain to its terminal at the first link's position", () => {
    const rows = treeOrder([
      rec({ id: "a", createdAt: 1, state: "handoff", successorId: "a2" }),
      rec({ id: "b", createdAt: 2 }),
      rec({ id: "a2", createdAt: 9, predecessorId: "a", chainIndex: 2 }),
    ]);

    expect(rows.map((row) => row.record.id)).toEqual(["a2", "b"]);
    expect(rows[0].depth).toBe(0);
  });

  it("attaches children of any chain link to the chain row", () => {
    const chain = [
      rec({ id: "a", createdAt: 1, state: "handoff", successorId: "a2" }),
      rec({ id: "b", createdAt: 2 }),
      rec({ id: "a2", createdAt: 9, predecessorId: "a", chainIndex: 2 }),
    ];
    const running = treeOrder([...chain, rec({ id: "k", callerId: "a", createdAt: 3 })]);

    expect(running.map((row) => row.record.id)).toEqual(["a2", "k", "b"]);
    expect(byId(running, "k")?.depth).toBe(1);
    expect(byId(running, "a2")?.openDescendants).toBe(1);

    const finished = treeOrder([...chain, rec({ id: "k", callerId: "a", createdAt: 3, state: "done" })]);

    expect(byId(finished, "a2")?.openDescendants).toBe(0);
  });

  it("counts open descendants over the whole subtree", () => {
    const rows = treeOrder([
      rec({ id: "a", createdAt: 1 }),
      rec({ id: "a1", callerId: "a", createdAt: 2, state: "done" }),
      rec({ id: "a1x", callerId: "a1", createdAt: 3 }),
    ]);

    expect(byId(rows, "a")?.openDescendants).toBe(1);
    expect(byId(rows, "a1")?.openDescendants).toBe(1);
  });

  it("honours a roots predicate", () => {
    const rows = treeOrder(
      [rec({ id: "a", createdAt: 1 }), rec({ id: "a1", callerId: "a", createdAt: 2 })],
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
