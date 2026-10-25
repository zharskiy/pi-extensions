import { PAD, type ThemeLike } from "../../../../platform/pi-adapter/index.ts";
import { DOT } from "../../../../platform/shared/index.ts";
import { type KeyHint, keyHints } from "../../../../platform/ui-kit/index.ts";
import {
  type PanelActionsAvailable,
  type PanelState,
  panelView,
} from "../../core/agent-panel/panel-state.ts";
import type { TreeRow } from "../../core/components/tree.ts";
import { type AgentRecord, isClosed } from "../../core/model/agent-record.ts";
import { renderRow, rowLayout } from "../components/agent-row.ts";
import { stopWords } from "../components/state-text.ts";

const IDLE_HINT: KeyHint[] = [["↓", "to select"]];

const listHint = (hidden: number, selected: boolean, theme: ThemeLike) => {
  const words = selected ? "to list" : "to list agents";

  return `${theme.fg("dim", DOT)}${theme.fg("muted", `${hidden} more, `)}${keyHints([["←", words]], theme)}`;
};

const hintLine = (pairs: KeyHint[], hidden: number, selected: boolean, width: number, theme: ThemeLike) => {
  const summary = hidden > 0 ? listHint(hidden, selected, theme) : "";

  return `${PAD}${theme.truncate(`${keyHints(pairs, theme)}${summary}`, Math.max(1, width - PAD.length))}`;
};

const hintPairs = (record: AgentRecord | undefined, actions: PanelActionsAvailable): KeyHint[] => {
  if (!record) {
    return IDLE_HINT;
  }

  const pairs: (KeyHint | undefined)[] = [
    ["esc", "to deselect"],
    actions.view ? ["enter", "to view"] : undefined,
    actions.stop || isClosed(record.state) ? ["x", stopWords(record.state)] : undefined,
  ];

  return pairs.filter((pair) => pair !== undefined);
};

export const panelLines = (
  rows: TreeRow[],
  state: PanelState,
  now: number,
  width: number,
  theme: ThemeLike,
  actions: PanelActionsAvailable,
): string[] => {
  if (rows.length === 0) {
    return [""];
  }

  const { shown, hidden } = panelView(rows, state);
  const selected = shown.find((entry) => entry.record.id === state.selectedId);
  const layout = rowLayout(shown, now, width, theme);
  const drawn = shown.map((entry) =>
    renderRow({ ...entry, selected: entry.record.id === state.selectedId }, width, theme, layout),
  );
  const hint = hintLine(hintPairs(selected?.record, actions), hidden, selected !== undefined, width, theme);

  return [...drawn, hint, ""];
};
