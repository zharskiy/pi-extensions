import type { ThemeLike } from "../../../../../core/adapter/contract.ts";
import { POINTER_COLS, renderRow, rowLayout } from "../../components/agent-row.ts";
import { innerWidth, PAD, SEP } from "../../components/format.ts";
import { stopHint } from "../../components/state-text.ts";
import { isTerminal, type TreeRow, treeOrder, withLinks } from "../../components/tree.ts";
import type { Settings } from "../../model/settings.ts";
import { type AgentRecord, isClosed } from "../../model/types.ts";

const WINDOW = 5;

type PanelSettings = Pick<Settings, "doneLingerMs" | "failedLingerMs">;

export type PanelState = { selectedId?: string; top: number; cleared: Set<string> };

export type PanelActionsAvailable = { view: boolean; stop: boolean };

export const createPanelState = (): PanelState => ({ top: 0, cleared: new Set() });

const isVisible = (
  record: AgentRecord,
  now: number,
  settings: PanelSettings,
  cleared: ReadonlySet<string>,
): boolean => {
  if (!isClosed(record.state)) {
    return true;
  }

  const age = now - (record.endedAt ?? now);
  const linger = record.state === "done" ? settings.doneLingerMs : settings.failedLingerMs;

  return age < linger && !cleared.has(record.id);
};

export const panelRows = (
  records: AgentRecord[],
  now: number,
  settings: PanelSettings,
  cleared: ReadonlySet<string>,
): TreeRow[] => {
  const byId = new Map(records.map((record) => [record.id, record]));
  const visible = records.filter(
    (record) => isTerminal(record, byId) && isVisible(record, now, settings, cleared),
  );
  const visibleIds = new Set(visible.map((record) => record.id));

  return treeOrder(withLinks(visible, byId)).filter((row) => visibleIds.has(row.record.id));
};

export const selectedIndex = (rows: TreeRow[], state: PanelState): number =>
  state.selectedId === undefined ? -1 : rows.findIndex((row) => row.record.id === state.selectedId);

const clampTop = (rows: TreeRow[], state: PanelState) => {
  state.top = Math.min(Math.max(0, state.top), Math.max(0, rows.length - WINDOW));
};

export const reconcile = (rows: TreeRow[], state: PanelState): boolean => {
  const index = selectedIndex(rows, state);
  const deselected = state.selectedId !== undefined && index < 0;

  if (deselected) {
    state.selectedId = undefined;
  }

  if (index >= 0 && index < state.top) {
    state.top = index;
  }

  if (index >= state.top + WINDOW) {
    state.top = index - WINDOW + 1;
  }

  clampTop(rows, state);

  return deselected;
};

const windowOf = (rows: TreeRow[], state: PanelState) => {
  const start = state.top;
  const end = Math.min(rows.length, state.top + WINDOW);

  return { start, end, below: rows.length - end };
};

const hintText = (record: AgentRecord, actions: PanelActionsAvailable): string =>
  [
    actions.view ? "enter to view" : undefined,
    actions.stop || isClosed(record.state) ? stopHint(record.state) : undefined,
    "esc to deselect",
  ]
    .filter((part) => part !== undefined)
    .join(SEP);

export const panelLines = (
  rows: TreeRow[],
  state: PanelState,
  now: number,
  width: number,
  theme: ThemeLike,
  actions: PanelActionsAvailable,
): string[] => {
  const { start, end, below } = windowOf(rows, state);
  const marker = (text: string) => `${PAD}${" ".repeat(POINTER_COLS)}${theme.fg("dim", text)}`;
  const selected = rows.find((entry) => entry.record.id === state.selectedId);
  const layout = rowLayout(rows, now, width, theme);
  const lines = rows
    .slice(start, end)
    .map((entry) =>
      renderRow({ ...entry, selected: entry.record.id === state.selectedId }, now, width, theme, layout),
    );

  if (start > 0) {
    lines.unshift(marker(`↑ ${start} more`));
  }

  if (below > 0) {
    lines.push(marker(`↓ ${below} more`));
  }

  if (selected) {
    lines.push(PAD + theme.fg("dim", theme.truncate(hintText(selected.record, actions), innerWidth(width))));
  }

  lines.push("");

  return lines;
};
