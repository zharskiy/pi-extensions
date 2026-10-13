import { describe, expect, it, vi } from "vitest";
import { treeOrder } from "../../../src/components/tree.ts";
import type { AgentRecord } from "../../../src/model/types.ts";
import { type PanelActions, panelKeyHandler, selectFirst } from "../../../src/plugins/agent-panel/keys.ts";
import { createPanelState } from "../../../src/plugins/agent-panel/model.ts";
import { agentRecord } from "../../helpers/records.ts";

const actionsFor = (records: AgentRecord[], options: { view?: boolean; stop?: boolean } = {}) => {
  const state = createPanelState();
  const actions = {
    rows: () => treeOrder(records.filter((record) => !state.cleared.has(record.id))),
    state,
    refresh: vi.fn(),
    release: vi.fn(),
    view: options.view === false ? undefined : vi.fn(),
    stop: options.stop === false ? undefined : vi.fn(),
  } satisfies PanelActions;

  return actions;
};

const three = () => [
  agentRecord({ id: "a", createdAt: 1 }),
  agentRecord({ id: "b", createdAt: 2 }),
  agentRecord({ id: "c", createdAt: 3 }),
];

describe("panel keys", () => {
  it("down moves to the next row and clamps at the last", () => {
    const actions = actionsFor(three());
    const handle = panelKeyHandler(actions);

    actions.state.selectedId = "a";

    expect(handle({ name: "down" })).toBe("consumed");
    expect(actions.state.selectedId).toBe("b");

    handle({ name: "down" });
    handle({ name: "down" });

    expect(actions.state.selectedId).toBe("c");
    expect(actions.refresh).toHaveBeenCalledTimes(3);
  });

  it("up moves to the previous row and deselects on the first", () => {
    const actions = actionsFor(three());
    const handle = panelKeyHandler(actions);

    actions.state.selectedId = "b";

    expect(handle({ name: "up" })).toBe("consumed");
    expect(actions.state.selectedId).toBe("a");
    expect(actions.release).not.toHaveBeenCalled();
    expect(handle({ name: "up" })).toBe("consumed");
    expect(actions.state.selectedId).toBeUndefined();
    expect(actions.release).toHaveBeenCalledTimes(1);
  });

  it("left is consumed and keeps the selection; right deselects and releases", () => {
    const actions = actionsFor(three());
    const handle = panelKeyHandler(actions);

    actions.state.selectedId = "b";

    expect(handle({ name: "left" })).toBe("consumed");
    expect(actions.state.selectedId).toBe("b");
    expect(actions.release).not.toHaveBeenCalled();
    expect(handle({ name: "right" })).toBe("release");
    expect(actions.state.selectedId).toBeUndefined();
    expect(actions.release).toHaveBeenCalledTimes(1);
  });

  it("enter opens the view with the selected id and deselects", () => {
    const actions = actionsFor(three());

    actions.state.selectedId = "b";

    expect(panelKeyHandler(actions)({ name: "enter" })).toBe("consumed");
    expect(actions.view).toHaveBeenCalledWith("b");
    expect(actions.state.selectedId).toBeUndefined();
    expect(actions.release).toHaveBeenCalledTimes(1);
  });

  it("x stops an open row, closes a grace row now and clears a closed row", () => {
    const actions = actionsFor([
      agentRecord({ id: "run", createdAt: 1 }),
      agentRecord({ id: "grace", createdAt: 2, state: "grace" }),
      agentRecord({ id: "done", createdAt: 3, state: "done", endedAt: 4 }),
    ]);
    const handle = panelKeyHandler(actions);
    const x = { name: "other", char: "x" } as const;

    actions.state.selectedId = "run";

    expect(handle(x)).toBe("consumed");
    expect(actions.stop).toHaveBeenLastCalledWith("run");

    actions.state.selectedId = "grace";
    handle(x);

    expect(actions.stop).toHaveBeenLastCalledWith("grace");

    actions.state.selectedId = "done";
    handle(x);

    expect(actions.state.cleared.has("done")).toBe(true);
    expect(actions.stop).toHaveBeenCalledTimes(2);
  });

  it("x on a closed row clears it and moves the selection to the next row", () => {
    const actions = actionsFor([
      agentRecord({ id: "a", createdAt: 1, state: "done", endedAt: 4 }),
      agentRecord({ id: "b", createdAt: 2 }),
    ]);

    actions.state.selectedId = "a";

    expect(panelKeyHandler(actions)({ name: "other", char: "x" })).toBe("consumed");
    expect(actions.state.cleared.has("a")).toBe(true);
    expect(actions.state.selectedId).toBe("b");
    expect(actions.release).not.toHaveBeenCalled();
  });

  it("x on the last closed row clears it and moves the selection to the previous row", () => {
    const actions = actionsFor([
      agentRecord({ id: "a", createdAt: 1 }),
      agentRecord({ id: "b", createdAt: 2, state: "failed", endedAt: 4 }),
    ]);

    actions.state.selectedId = "b";
    panelKeyHandler(actions)({ name: "other", char: "x" });

    expect(actions.state.selectedId).toBe("a");
    expect(actions.release).not.toHaveBeenCalled();
  });

  it("x on the only closed row clears it, deselects and releases", () => {
    const actions = actionsFor([agentRecord({ id: "a", state: "done", endedAt: 4 })]);

    actions.state.selectedId = "a";

    expect(panelKeyHandler(actions)({ name: "other", char: "x" })).toBe("consumed");
    expect(actions.state.selectedId).toBeUndefined();
    expect(actions.release).toHaveBeenCalledTimes(1);
  });

  it("x keeps the selection on a running row it stops", () => {
    const actions = actionsFor(three());

    actions.state.selectedId = "b";
    panelKeyHandler(actions)({ name: "other", char: "x" });

    expect(actions.stop).toHaveBeenCalledWith("b");
    expect(actions.state.selectedId).toBe("b");
    expect(actions.release).not.toHaveBeenCalled();
  });

  it("releases any key when the selected row is already gone", () => {
    const actions = actionsFor(three());

    actions.state.selectedId = "gone";

    expect(panelKeyHandler(actions)({ name: "down" })).toBe("release");
    expect(actions.state.selectedId).toBeUndefined();
    expect(actions.release).toHaveBeenCalledTimes(1);
  });

  it("x does nothing on an open row without the stop action", () => {
    const actions = actionsFor(three(), { stop: false });

    actions.state.selectedId = "a";

    expect(panelKeyHandler(actions)({ name: "other", char: "x" })).toBe("consumed");
    expect(actions.state.selectedId).toBe("a");
    expect(actions.state.cleared.size).toBe(0);
  });

  it("escape deselects and is consumed", () => {
    const actions = actionsFor(three());

    actions.state.selectedId = "a";

    expect(panelKeyHandler(actions)({ name: "escape" })).toBe("consumed");
    expect(actions.state.selectedId).toBeUndefined();
    expect(actions.release).toHaveBeenCalledTimes(1);
  });

  it("any other key clears the selection and is released", () => {
    const actions = actionsFor(three());
    const handle = panelKeyHandler(actions);

    actions.state.selectedId = "a";

    expect(handle({ name: "other", char: "a" })).toBe("release");
    expect(actions.state.selectedId).toBeUndefined();

    actions.state.selectedId = "a";

    expect(handle({ name: "tab" })).toBe("release");
    expect(actions.state.selectedId).toBeUndefined();
  });

  it("selectFirst picks the first row and reports false without rows", () => {
    const actions = actionsFor(three());

    actions.state.top = 2;

    expect(selectFirst(actions)).toBe(true);
    expect(actions.state).toMatchObject({ selectedId: "a", top: 0 });
    expect(actions.refresh).toHaveBeenCalledTimes(1);
    expect(selectFirst(actionsFor([]))).toBe(false);
  });
});
