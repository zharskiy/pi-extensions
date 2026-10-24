import { PAD, type ThemeLike } from "../../../../pi-adapter/index.ts";
import { type KeyHint, keyHints } from "../../../../ui-kit/index.ts";
import {
  type PanelActionsAvailable,
  type PanelState,
  panelWindow,
} from "../../core/agent-panel/panel-state.ts";
import type { TreeRow } from "../../core/components/tree.ts";
import { type AgentRecord, isClosed } from "../../core/model/agent-record.ts";
import { POINTER_BLANK, renderRow, rowLayout } from "../components/agent-row.ts";
import { stopWords } from "../components/state-text.ts";

const hintPairs = (record: AgentRecord, actions: PanelActionsAvailable): KeyHint[] => {
  const pairs: (KeyHint | undefined)[] = [
    actions.view ? ["enter", "to view"] : undefined,
    actions.stop || isClosed(record.state) ? ["x", stopWords(record.state)] : undefined,
    ["esc", "to deselect"],
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
  const { start, end, below } = panelWindow(rows, state);
  const marker = (text: string) => `${PAD}${POINTER_BLANK}${theme.fg("dim", text)}`;
  const selected = rows.find((entry) => entry.record.id === state.selectedId);
  const layout = rowLayout(rows, now, width, theme);
  const lines = rows
    .slice(start, end)
    .map((entry) =>
      renderRow({ ...entry, selected: entry.record.id === state.selectedId }, width, theme, layout),
    );

  if (start > 0) {
    lines.unshift(marker(`↑ ${start} more`));
  }

  if (below > 0) {
    lines.push(marker(`↓ ${below} more`));
  }

  if (selected) {
    lines.push(theme.truncate(PAD + keyHints(hintPairs(selected.record, actions), theme), width));
  }

  lines.push("");

  return lines;
};
