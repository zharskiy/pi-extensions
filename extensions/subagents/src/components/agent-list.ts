import type { ThemeLike } from "../../../../core/adapter/contract.ts";
import { type AgentRecord, isClosed } from "../model/types.ts";
import { treeRow } from "./agent-row.ts";

type AgentGroup = "working" | "attention" | "done" | "failed" | "closed";

const GROUP_ORDER: AgentGroup[] = ["working", "attention", "done", "failed", "closed"];

const GROUP_TITLES: Record<AgentGroup, string> = {
  working: "Working",
  attention: "Needs attention",
  done: "Done",
  failed: "Failed",
  closed: "Closed",
};

export type ListEntry =
  | { kind: "header"; group: AgentGroup; count: number }
  | { kind: "agent"; record: AgentRecord };

type RenderedList = { lines: string[]; selectedRow?: number };

export const groupOf = (record: AgentRecord): AgentGroup => {
  const open = !isClosed(record.state);

  if (open && record.state === "grace") {
    return "attention";
  }

  if (open) {
    return "working";
  }

  if (record.state === "done" || record.state === "failed") {
    return record.state;
  }

  return "closed";
};

const matchesFilter = (record: AgentRecord, filter: string) => {
  const needle = filter.trim().toLowerCase();

  if (needle.length === 0) {
    return true;
  }

  return [record.agent, record.id, record.state, GROUP_TITLES[groupOf(record)]].some((field) =>
    field.toLowerCase().includes(needle),
  );
};

export const listEntries = (records: AgentRecord[], filter: string): ListEntry[] => {
  const newestFirst = records
    .filter((record) => matchesFilter(record, filter))
    .reverse()
    .sort((left, right) => right.createdAt - left.createdAt);

  return GROUP_ORDER.flatMap((group) => {
    const members = newestFirst.filter((record) => groupOf(record) === group);

    if (members.length === 0) {
      return [];
    }

    const entries: ListEntry[] = members.map((record) => ({ kind: "agent", record }));

    entries.unshift({ kind: "header", group, count: members.length });

    return entries;
  });
};

const agentIds = (entries: ListEntry[]) =>
  entries.flatMap((entry) => (entry.kind === "agent" ? [entry.record.id] : []));

export const resolveSelection = (entries: ListEntry[], selectedId: string | undefined) => {
  const ids = agentIds(entries);

  return selectedId !== undefined && ids.includes(selectedId) ? selectedId : ids[0];
};

export const moveSelection = (entries: ListEntry[], selectedId: string | undefined, delta: number) => {
  const ids = agentIds(entries);
  const current = ids.indexOf(resolveSelection(entries, selectedId) ?? "");
  const next = Math.min(ids.length - 1, Math.max(0, current + delta));

  return ids[next];
};

export const selectedRecord = (entries: ListEntry[], selectedId: string | undefined) => {
  const id = resolveSelection(entries, selectedId);
  const match = entries.find((entry) => entry.kind === "agent" && entry.record.id === id);

  return match?.kind === "agent" ? match.record : undefined;
};

export const emptyListText = (total: number, filter: string) =>
  total === 0 ? "no agents in this session yet" : `no agents match "${filter.trim()}"`;

export const renderList = (
  entries: ListEntry[],
  selectedId: string | undefined,
  now: number,
  frame: number,
  theme: ThemeLike,
  width: number,
): RenderedList => {
  const selected = resolveSelection(entries, selectedId);
  const lines: string[] = [];
  let selectedRow: number | undefined;

  entries.forEach((entry) => {
    if (entry.kind === "header") {
      if (lines.length > 0) {
        lines.push("");
      }

      lines.push(theme.bold(`${GROUP_TITLES[entry.group]} · ${entry.count}`));

      return;
    }

    const isSelected = entry.record.id === selected;
    const marker = isSelected ? theme.fg("accent", theme.bold("›")) : " ";

    if (isSelected) {
      selectedRow = lines.length;
    }

    lines.push(`${marker} ${treeRow(entry.record, now, frame, theme, width - 2)}`);
  });

  return { lines, selectedRow };
};
