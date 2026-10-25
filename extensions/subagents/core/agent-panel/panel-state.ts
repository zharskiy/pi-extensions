import { isTerminal, type TreeRow, treeOrder, withLinks } from "../components/tree.ts";
import { type AgentRecord, isClosed } from "../model/agent-record.ts";
import type { Settings } from "../model/settings.ts";

const PANEL_ROWS = 5;

type PanelSettings = Pick<Settings, "doneLingerMs" | "failedLingerMs">;

export type PanelState = { selectedId?: string; cleared: Set<string> };

export type PanelActionsAvailable = { view: boolean; stop: boolean };

export const createPanelState = (): PanelState => ({ cleared: new Set() });

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

const leadOf = (rows: TreeRow[], index: number) =>
  rows
    .slice(0, index + 1)
    .reverse()
    .find((row) => row.depth === 0);

export const reconcile = (rows: TreeRow[], state: PanelState): boolean => {
  const index = selectedIndex(rows, state);
  const deselected = state.selectedId !== undefined && index < 0;

  if (deselected) {
    state.selectedId = undefined;
  }

  const lead = rows.length > PANEL_ROWS && index >= 0 ? leadOf(rows, index) : undefined;

  if (lead) {
    state.selectedId = lead.record.id;
  }

  return deselected;
};

const isOpen = (row: TreeRow) => !isClosed(row.record.state) || row.openDescendants > 0;

const openFirst = (rows: TreeRow[]) => [...rows.filter(isOpen), ...rows.filter((row) => !isOpen(row))];

const fitted = (rows: TreeRow[]) => {
  if (rows.length <= PANEL_ROWS) {
    return rows;
  }

  const leads = rows.filter((row) => row.depth === 0);

  return leads.length <= PANEL_ROWS ? leads : openFirst(leads).slice(0, PANEL_ROWS);
};

const pinned = (shown: TreeRow[], rows: TreeRow[], selectedId: string | undefined) => {
  const selected = rows.find((row) => row.record.id === selectedId);

  if (!selected || shown.includes(selected)) {
    return shown;
  }

  const kept = shown.length < PANEL_ROWS ? shown : shown.slice(0, -1);

  return [...kept, selected];
};

export const panelView = (rows: TreeRow[], state: PanelState) => {
  const shown = pinned(fitted(rows), rows, state.selectedId);

  return { shown, hidden: rows.length - shown.length };
};
