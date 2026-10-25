import { PAD, type ThemeLike } from "../../../../platform/pi-adapter/index.ts";
import { DOT } from "../../../../platform/shared/index.ts";
import { hintRow, type KeyHint, keyHints } from "../../../../platform/ui-kit/index.ts";
import {
  type PanelActionsAvailable,
  type PanelState,
  panelView,
} from "../../core/agent-panel/panel-state.ts";
import type { TreeRow } from "../../core/components/tree.ts";
import { type AgentRecord, isClosed } from "../../core/model/agent-record.ts";
import { POINTER_BLANK, renderRow, rowLayout } from "../components/agent-row.ts";
import { stopWords } from "../components/state-text.ts";

const IDLE_HINT: KeyHint[] = [["↓", "to select"]];

const LIST_HINT: KeyHint[] = [["←", "to list agents"]];

const summaryRow = (hidden: number, width: number, theme: ThemeLike) => {
  const prefix = `${PAD}${POINTER_BLANK}`;
  const text = `${theme.fg("muted", `${hidden} more`)}${theme.fg("dim", DOT)}${keyHints(LIST_HINT, theme)}`;

  return `${prefix}${theme.truncate(text, Math.max(1, width - theme.width(prefix)))}`;
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
  const list = hidden > 0 ? [...drawn, summaryRow(hidden, width, theme)] : drawn;
  const hint = hintRow(theme, hintPairs(selected?.record, actions), width);

  return [...list, hint, ""];
};
