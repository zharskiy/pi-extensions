import { PAD, type ThemeLike } from "../../../../platform/pi-adapter/index.ts";
import { type KeyHint, keyHints } from "../../../../platform/ui-kit/index.ts";
import {
  type PanelActionsAvailable,
  type PanelState,
  panelWindow,
} from "../../core/agent-panel/panel-state.ts";
import type { TreeRow } from "../../core/components/tree.ts";
import { type AgentRecord, isClosed } from "../../core/model/agent-record.ts";
import { POINTER_BLANK, renderRow, rowLayout } from "../components/agent-row.ts";
import { stopWords } from "../components/state-text.ts";

const IDLE_HINT: KeyHint[] = [["↓", "to select"]];

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

  const { start, end, below, scrolls } = panelWindow(rows, state);
  const marker = (text: string) => `${PAD}${POINTER_BLANK}${theme.fg("dim", text)}`;
  const selected = rows.find((entry) => entry.record.id === state.selectedId);
  const layout = rowLayout(rows, now, width, theme);
  const slot = (arrow: string, hidden: number) => (hidden > 0 ? marker(`${arrow} ${hidden} more`) : "");
  const window = rows
    .slice(start, end)
    .map((entry) =>
      renderRow({ ...entry, selected: entry.record.id === state.selectedId }, width, theme, layout),
    );
  const list = scrolls ? [slot("↑", start), ...window, slot("↓", below)] : window;
  const hint = theme.truncate(PAD + keyHints(hintPairs(selected?.record, actions), theme), width);

  return [...list, hint, ""];
};
