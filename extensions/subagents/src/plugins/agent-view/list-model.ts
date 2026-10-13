import { SEP } from "../../components/format.ts";
import { type TreeRow, treeOrder } from "../../components/tree.ts";
import { type AgentRecord, isClosed, MAIN_CALLER } from "../../model/types.ts";

type ById = ReadonlyMap<string, AgentRecord>;

export type ListSection = { title: string; rows: TreeRow[] };

const terminalOf = (record: AgentRecord, byId: ById): AgentRecord => {
  const successor = record.successorId ? byId.get(record.successorId) : undefined;

  return successor ? terminalOf(successor, byId) : record;
};

const firstLinkOf = (record: AgentRecord, byId: ById): AgentRecord => {
  const predecessor = record.predecessorId ? byId.get(record.predecessorId) : undefined;

  return predecessor ? firstLinkOf(predecessor, byId) : record;
};

const isTerminal = (record: AgentRecord, byId: ById) => !record.successorId || !byId.has(record.successorId);

const callerOf = (record: AgentRecord, byId: ById): AgentRecord | undefined => {
  const callerId = firstLinkOf(record, byId).callerId;
  const caller = callerId === MAIN_CALLER ? undefined : byId.get(callerId);

  return caller ? terminalOf(caller, byId) : undefined;
};

const indexOf = (records: AgentRecord[]) => new Map(records.map((record) => [record.id, record]));

const terminalsOf = (records: AgentRecord[], byId: ById) =>
  records.filter((record) => isTerminal(record, byId));

export const isListRoot = (record: AgentRecord, byId: ById): boolean => {
  const caller = callerOf(record, byId);

  return !caller || (!isClosed(record.state) && isClosed(caller.state));
};

const rootOf = (record: AgentRecord, byId: ById): AgentRecord => {
  const caller = callerOf(record, byId);

  return !caller || isListRoot(record, byId) ? record : rootOf(caller, byId);
};

const withLinks = (records: AgentRecord[], byId: ById): AgentRecord[] => {
  const links = new Map<string, AgentRecord>();

  const add = (record: AgentRecord) => {
    const predecessor = record.predecessorId ? byId.get(record.predecessorId) : undefined;

    if (predecessor && !links.has(predecessor.id)) {
      links.set(predecessor.id, predecessor);
      add(predecessor);
    }
  };

  records.forEach(add);

  return [...records, ...links.values()];
};

/** Records the `/agents` list shows (chain terminals, plus the earlier links of their chains). */
export const visibleRecords = (
  records: AgentRecord[],
  now: number,
  lingerMs: number,
  cleared: ReadonlySet<string>,
): AgentRecord[] => {
  const byId = indexOf(records);
  const terminals = terminalsOf(records, byId);
  const ageOf = (record: AgentRecord) => now - (record.endedAt ?? now);
  const hidden = (record: AgentRecord) => isClosed(record.state) && cleared.has(record.id);

  const listedAlone = (record: AgentRecord) => {
    if (!isClosed(record.state)) {
      return true;
    }

    const root = rootOf(record, byId);

    if (isClosed(root.state)) {
      return ageOf(root) < lingerMs;
    }

    const caller = callerOf(record, byId);

    return ageOf(record) < lingerMs || (caller !== undefined && !isClosed(caller.state));
  };

  const listed = new Set<string>();

  const keep = (record: AgentRecord) => {
    if (listed.has(record.id) || hidden(record)) {
      return;
    }

    listed.add(record.id);

    const caller = isListRoot(record, byId) ? undefined : callerOf(record, byId);

    if (caller) {
      keep(caller);
    }
  };

  terminals.filter((record) => !hidden(record) && listedAlone(record)).forEach(keep);

  return withLinks(
    terminals.filter((record) => listed.has(record.id)),
    byId,
  );
};

/** The chain terminals of `visible`: one per row. */
export const listedTerminals = (visible: AgentRecord[]): AgentRecord[] =>
  terminalsOf(visible, indexOf(visible));

const subtreeOf = (root: AgentRecord, terminals: AgentRecord[], byId: ById) =>
  terminals.filter((record) => rootOf(record, byId).id === root.id);

export const listSections = (visible: AgentRecord[]): ListSection[] => {
  const byId = indexOf(visible);
  const terminals = terminalsOf(visible, byId);
  const isRoot = (record: AgentRecord) => isListRoot(record, byId);
  const running = terminals.filter((record) => !isClosed(rootOf(record, byId).state));

  const completedRoots = terminals
    .filter((record) => isRoot(record) && isClosed(record.state))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

  const completed = completedRoots.flatMap((root) =>
    treeOrder(withLinks(subtreeOf(root, terminals, byId), byId), (record) => record.id === root.id),
  );

  const sections: ListSection[] = [
    { title: "Running", rows: treeOrder(withLinks(running, byId), isRoot) },
    { title: `Completed (${completedRoots.length})`, rows: completed },
  ];

  return sections.filter((section) => section.rows.length > 0);
};

export const subtitle = (visible: AgentRecord[]): string => {
  const terminals = listedTerminals(visible);
  const open = terminals.filter((record) => !isClosed(record.state)).length;
  const done = terminals.length - open;

  const parts = [open > 0 ? `${open} running` : undefined, done > 0 ? `${done} done` : undefined].filter(
    (part) => part !== undefined,
  );

  return parts.length === 0 ? "" : SEP + parts.join(SEP);
};

export const clearTargets = (id: string, visible: AgentRecord[]): string[] => {
  const byId = indexOf(visible);
  const terminals = terminalsOf(visible, byId);
  const target = terminals.find((record) => record.id === id);

  if (!target || !isClosed(target.state)) {
    return [];
  }

  const below = (record: AgentRecord): boolean => {
    if (isListRoot(record, byId)) {
      return false;
    }

    const caller = callerOf(record, byId);

    return caller !== undefined && (caller.id === id || below(caller));
  };

  return [
    id,
    ...terminals
      .filter((record) => record.id !== id && isClosed(record.state) && below(record))
      .map((r) => r.id),
  ];
};

const STOP_PART: Record<"open" | "grace" | "closed", string> = {
  open: "x to stop",
  grace: "x to close now",
  closed: "x to clear",
};

export const listHint = (selected: AgentRecord | undefined): string => {
  if (!selected) {
    return "esc to close";
  }

  const kind = selected.state === "grace" ? "grace" : isClosed(selected.state) ? "closed" : "open";

  return ["↑/↓ to select", "enter to view", STOP_PART[kind], "X to stop all", "esc to close"].join(SEP);
};

export const carrySelection = (
  previousIds: string[],
  ids: string[],
  selected: string | undefined,
): string | undefined => {
  if (selected === undefined || ids.includes(selected)) {
    return selected;
  }

  const index = previousIds.indexOf(selected);
  const kept = new Set(ids);
  const after = previousIds.slice(index + 1).find((id) => kept.has(id));
  const before = previousIds
    .slice(0, Math.max(0, index))
    .reverse()
    .find((id) => kept.has(id));

  return after ?? before;
};
