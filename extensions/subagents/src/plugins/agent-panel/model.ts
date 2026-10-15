import type { ThemeLike } from "../../../../../core/adapter/contract.ts";
import { type RowInput, type RowLayout, renderRow, rowLayout } from "../../components/agent-row.ts";
import { innerWidth, PAD, SEP } from "../../components/format.ts";
import { stopHint } from "../../components/state-text.ts";
import { isTerminal, type TreeRow, treeOrder, withLinks } from "../../components/tree.ts";
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

export const hintText = (record: AgentRecord, actions: PanelActionsAvailable): string =>
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
  row: RowRenderer,
  actions: PanelActionsAvailable,
): string[] => {
  if (rows.length === 0) {
    return [];
  }

  const { start, end, above, below } = windowOf(rows, state);
  const marker = (text: string) => `${PAD}${theme.fg("dim", text)}`;
  const selected = rows.find((entry) => entry.record.id === state.selectedId);
  const layout = rowLayout(rows, now, width, selected !== undefined, theme);
  const lines = rows
    .slice(start, end)
    .map((entry) =>
      row({ ...entry, selected: entry.record.id === state.selectedId }, now, width, theme, layout),
    );

  if (above > 0) {
    lines.unshift(marker(`↑ ${above} more`));
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

type CachedRow = { key: string; theme: ThemeLike; line: string };

const cacheKey = (input: RowInput, width: number, layout: RowLayout) =>
  [
    input.record.version,
    width,
    input.selected,
    input.depth,
    input.last,
    input.ancestorsContinue.join(""),
    input.openDescendants,
    layout.nameCols,
    layout.infoAt,
  ].join("|");

export const createClosedRowCache = (): RowRenderer & { prune(rows: TreeRow[]): void } => {
  const cache = new Map<string, CachedRow>();

  const row: RowRenderer = (input, now, width, theme, layout) => {
    if (!isClosed(input.record.state)) {
      return renderRow(input, now, width, theme, layout);
    }

    const key = cacheKey(input, width, layout);
    const cached = cache.get(input.record.id);

    if (cached && cached.key === key && cached.theme === theme) {
      return cached.line;
    }

    const line = renderRow(input, now, width, theme, layout);

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
