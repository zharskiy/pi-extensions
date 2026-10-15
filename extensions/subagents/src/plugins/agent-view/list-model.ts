import { SEP } from "../../components/format.ts";
import { stopHint } from "../../components/state-text.ts";
import { isTerminal, type TreeRow, treeOrder, withLinks } from "../../components/tree.ts";
import { type AgentRecord, chainLinks, chainTerminal, isClosed, MAIN_CALLER } from "../../model/types.ts";

type ById = ReadonlyMap<string, AgentRecord>;

export type ListSection = { title: string; rows: TreeRow[] };

const callerOf = (record: AgentRecord, byId: ById): AgentRecord | undefined => {
  const callerId = chainLinks(byId, record)[0].callerId;
  const caller = callerId === MAIN_CALLER ? undefined : byId.get(callerId);

  return caller ? chainTerminal(byId, caller) : undefined;
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

export const listHint = (selected: AgentRecord | undefined): string => {
  if (!selected) {
    return "esc to close";
  }

  return ["↑/↓ to select", "enter to view", stopHint(selected.state), "X to stop all", "esc to close"].join(
    SEP,
  );
};
