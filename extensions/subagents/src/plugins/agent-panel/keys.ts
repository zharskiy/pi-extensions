import type { EditorKeyHandler } from "../../../../../core/adapter/contract.ts";
import type { TreeRow } from "../../components/tree.ts";
import { isClosed } from "../../model/types.ts";
import { type PanelState, selectedIndex } from "./model.ts";

export type PanelActions = {
  rows(): TreeRow[];
  state: PanelState;
  refresh(): void;
  view?: (id: string) => void;
  stop?: (id: string) => void;
  release(): void;
};

const deselect = (actions: PanelActions) => {
  actions.state.selectedId = undefined;
  actions.release();
  actions.refresh();
};

const move = (actions: PanelActions, step: 1 | -1) => {
  const rows = actions.rows();
  const index = selectedIndex(rows, actions.state);

  if (step < 0 && index <= 0) {
    deselect(actions);
    return;
  }

  const next = rows[Math.min(index + step, rows.length - 1)];

  actions.state.selectedId = next?.record.id;
  actions.refresh();
};

const clear = (actions: PanelActions, before: TreeRow[], id: string) => {
  const index = before.findIndex((row) => row.record.id === id);

  actions.state.cleared.add(id);

  const remaining = new Set(actions.rows().map((row) => row.record.id));
  const next =
    before.slice(index + 1).find((row) => remaining.has(row.record.id)) ??
    before
      .slice(0, index)
      .reverse()
      .find((row) => remaining.has(row.record.id));

  if (!next) {
    deselect(actions);
    return;
  }

  actions.state.selectedId = next.record.id;
  actions.refresh();
};

const stopOrClear = (actions: PanelActions) => {
  const rows = actions.rows();
  const record = rows[selectedIndex(rows, actions.state)]?.record;

  if (!record) {
    return;
  }

  if (isClosed(record.state)) {
    clear(actions, rows, record.id);
    return;
  }

  actions.stop?.(record.id);
};

export const panelKeyHandler =
  (actions: PanelActions): EditorKeyHandler =>
  (key) => {
    if (selectedIndex(actions.rows(), actions.state) < 0) {
      deselect(actions);
      return "release";
    }

    if (key.name === "down") {
      move(actions, 1);
      return "consumed";
    }

    if (key.name === "up") {
      move(actions, -1);
      return "consumed";
    }

    if (key.name === "enter") {
      const id = actions.state.selectedId;

      deselect(actions);

      if (id !== undefined) {
        actions.view?.(id);
      }

      return "consumed";
    }

    if (key.name === "left") {
      return "consumed";
    }

    if (key.name === "escape") {
      deselect(actions);
      return "consumed";
    }

    if (key.name === "other" && key.char === "x") {
      stopOrClear(actions);
      return "consumed";
    }

    deselect(actions);

    return "release";
  };

export const selectFirst = (actions: PanelActions): boolean => {
  const first = actions.rows()[0];

  if (!first) {
    return false;
  }

  actions.state.selectedId = first.record.id;
  actions.state.top = 0;
  actions.refresh();

  return true;
};
