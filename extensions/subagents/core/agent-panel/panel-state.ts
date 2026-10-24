import { isTerminal, type TreeRow, treeOrder, withLinks } from "../components/tree.ts";
import { type AgentRecord, isClosed } from "../model/agent-record.ts";
import type { Settings } from "../model/settings.ts";

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

export const panelWindow = (rows: TreeRow[], state: PanelState) => {
  const start = state.top;
  const end = Math.min(rows.length, state.top + WINDOW);

  return { start, end, below: rows.length - end };
};
