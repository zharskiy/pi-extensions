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

export const reconcile = (rows: TreeRow[], state: PanelState): boolean => {
  const deselected = state.selectedId !== undefined && selectedIndex(rows, state) < 0;

  if (deselected) {
    state.selectedId = undefined;
  }

  return deselected;
};

const openFirst = (rows: TreeRow[]) => [
  ...rows.filter((row) => !isClosed(row.record.state)),
  ...rows.filter((row) => isClosed(row.record.state)),
];

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

  return [...shown.slice(0, -1), selected];
};

export const panelView = (rows: TreeRow[], state: PanelState) => {
  const shown = pinned(fitted(rows), rows, state.selectedId);

  return { shown, hidden: rows.length - shown.length };
};
