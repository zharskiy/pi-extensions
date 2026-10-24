import type { EditorKeyHandler, KeyPress } from "../../../../../pi-adapter/index.ts";
import { carrySelection, type TreeRow } from "../../../core/components/tree.ts";
import { isClosed } from "../../../core/model/types.ts";
import { type PanelState, selectedIndex } from "./model.ts";

export type PanelActions = {
  rows(): TreeRow[];
  state: PanelState;
  refresh(): void;
  view(id: string): void;
  stop(id: string): void;
  release(): void;
};

type Outcome = "consumed" | "release";

type Press = { actions: PanelActions; rows: TreeRow[]; index: number };

const deselect = (actions: PanelActions) => {
  actions.state.selectedId = undefined;
  actions.release();
  actions.refresh();
};

const move = ({ actions, rows, index }: Press, step: 1 | -1): Outcome => {
  if (step < 0 && index === 0) {
    deselect(actions);
    return "consumed";
  }

  actions.state.selectedId = rows[Math.min(index + step, rows.length - 1)].record.id;
  actions.refresh();

  return "consumed";
};

const ids = (rows: TreeRow[]) => rows.map((row) => row.record.id);

const stopOrClear = ({ actions, rows, index }: Press): Outcome => {
  const { record } = rows[index];

  if (!isClosed(record.state)) {
    actions.stop(record.id);
    return "consumed";
  }

  actions.state.cleared.add(record.id);

  const next = carrySelection(ids(rows), ids(actions.rows()), record.id);

  if (!next) {
    deselect(actions);
    return "consumed";
  }

  actions.state.selectedId = next;
  actions.refresh();

  return "consumed";
};

const names: Partial<Record<KeyPress["name"], (press: Press) => Outcome>> = {
  down: (press) => move(press, 1),
  up: (press) => move(press, -1),
  enter: ({ actions, rows, index }) => {
    deselect(actions);
    actions.view(rows[index].record.id);
    return "consumed";
  },
  escape: ({ actions }) => {
    deselect(actions);
    return "consumed";
  },
};

const chars: Record<string, (press: Press) => Outcome> = { x: stopOrClear };

export const panelKeyHandler =
  (actions: PanelActions): EditorKeyHandler =>
  (key) => {
    const rows = actions.rows();
    const index = selectedIndex(rows, actions.state);
    const binding = key.name === "other" && key.char ? chars[key.char] : names[key.name];

    if (index < 0 || !binding) {
      deselect(actions);
      return "release";
    }

    return binding({ actions, rows, index });
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
