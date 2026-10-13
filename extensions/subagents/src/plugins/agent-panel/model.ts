import type { ThemeLike } from "../../../../../core/adapter/contract.ts";
import { nameColumn, type RowInput, renderRow } from "../../components/agent-row.ts";
import { innerWidth, PAD, SEP, truncateCols } from "../../components/format.ts";
import { type TreeRow, treeOrder } from "../../components/tree.ts";
import type { Settings } from "../../model/settings.ts";
import { type AgentRecord, isClosed } from "../../model/types.ts";

export const WINDOW = 5;

export type PanelSettings = Pick<Settings, "doneLingerMs" | "failedLingerMs">;

export type PanelState = { selectedId?: string; top: number; cleared: Set<string> };

export type PanelActionsAvailable = { view: boolean; stop: boolean };

export type RowRenderer = typeof renderRow;

export const createPanelState = (): PanelState => ({ top: 0, cleared: new Set() });

export const isVisible = (
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
  const visible = records.filter((record) => isVisible(record, now, settings, cleared));
  const visibleIds = new Set(visible.map((record) => record.id));
  const links = new Map<string, AgentRecord>();

  const addLinks = (record: AgentRecord) => {
    const predecessor = record.predecessorId ? byId.get(record.predecessorId) : undefined;

    if (!predecessor || visibleIds.has(predecessor.id) || links.has(predecessor.id)) {
      return;
    }

    links.set(predecessor.id, predecessor);
    addLinks(predecessor);
  };

  visible.forEach(addLinks);

  return treeOrder([...visible, ...links.values()]).filter((row) => visibleIds.has(row.record.id));
};

export const selectedIndex = (rows: TreeRow[], state: PanelState): number =>
  state.selectedId === undefined ? -1 : rows.findIndex((row) => row.record.id === state.selectedId);

const clampTop = (rows: TreeRow[], state: PanelState) => {
  state.top = Math.min(Math.max(0, state.top), Math.max(0, rows.length - WINDOW));
};

export const reconcile = (rows: TreeRow[], state: PanelState): { deselected: boolean } => {
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

  return { deselected };
};

export const windowOf = (rows: TreeRow[], state: PanelState) => {
  const start = state.top;
  const end = Math.min(rows.length, state.top + WINDOW);

  return { start, end, above: start, below: rows.length - end };
};

const stopPart = (record: AgentRecord) => {
  if (isClosed(record.state)) {
    return "x to clear";
  }

  return record.state === "grace" ? "x to close now" : "x to stop";
};

export const hintText = (record: AgentRecord, actions: PanelActionsAvailable): string =>
  [
    actions.view ? "enter to view" : undefined,
    actions.stop || isClosed(record.state) ? stopPart(record) : undefined,
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
  row: RowRenderer,
  actions: PanelActionsAvailable,
): string[] => {
  if (rows.length === 0) {
    return [];
  }

  const nameCols = nameColumn(rows);
  const { start, end, above, below } = windowOf(rows, state);
  const marker = (text: string) => `${PAD}  ${theme.fg("dim", text)}`;
  const selected = rows.find((entry) => entry.record.id === state.selectedId);
  const lines = rows
    .slice(start, end)
    .map((entry) =>
      row({ ...entry, selected: entry.record.id === state.selectedId }, now, width, theme, nameCols),
    );

  if (above > 0) {
    lines.unshift(marker(`↑ ${above} more`));
  }

  if (below > 0) {
    lines.push(marker(`↓ ${below} more`));
  }

  if (selected) {
    lines.push(PAD + theme.fg("dim", truncateCols(hintText(selected.record, actions), innerWidth(width))));
  }

  lines.push("");

  return lines;
};

type CachedRow = { key: string; theme: ThemeLike; line: string };

const cacheKey = (input: RowInput, width: number, nameCols: number) =>
  [
    input.record.version,
    width,
    input.selected,
    input.depth,
    input.last,
    input.ancestorsContinue.join(""),
    input.openDescendants,
    nameCols,
  ].join("|");

export const createClosedRowCache = (): RowRenderer & { prune(rows: TreeRow[]): void } => {
  const cache = new Map<string, CachedRow>();

  const row: RowRenderer = (input, now, width, theme, nameCols) => {
    if (!isClosed(input.record.state)) {
      return renderRow(input, now, width, theme, nameCols);
    }

    const key = cacheKey(input, width, nameCols);
    const cached = cache.get(input.record.id);

    if (cached && cached.key === key && cached.theme === theme) {
      return cached.line;
    }

    const line = renderRow(input, now, width, theme, nameCols);

    cache.set(input.record.id, { key, theme, line });

    return line;
  };

  const prune = (rows: TreeRow[]) => {
    const ids = new Set(rows.map((entry) => entry.record.id));

    cache.forEach((_, id) => {
      if (!ids.has(id)) {
        cache.delete(id);
      }
    });
  };

  return Object.assign(row, { prune });
};
