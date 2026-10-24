import { DOT } from "../../../../shared/index.ts";
import { isTerminal, type TreeRow, treeOrder, withLinks } from "../components/tree.ts";
import { type AgentRecord, isClosed, MAIN_CALLER } from "../model/types.ts";

type ById = ReadonlyMap<string, AgentRecord>;

type ListSection = { title: string; rows: TreeRow[] };

type Lookup = (record: AgentRecord) => AgentRecord;

const memoised = (compute: (record: AgentRecord, self: Lookup) => AgentRecord): Lookup => {
  const memo = new Map<string, AgentRecord>();

  const self: Lookup = (record) => {
    const known = memo.get(record.id);

    if (known) {
      return known;
    }

    const found = compute(record, self);

    memo.set(record.id, found);

    return found;
  };

  return self;
};

const indexOf = (records: AgentRecord[]) => new Map(records.map((record) => [record.id, record]));

const forestOf = (records: AgentRecord[]) => {
  const byId: ById = indexOf(records);
  const terminals = records.filter((record) => isTerminal(record, byId));

  const firstLink = memoised((record, self) => {
    const predecessor = record.predecessorId ? byId.get(record.predecessorId) : undefined;

    return predecessor ? self(predecessor) : record;
  });

  const lastLink = memoised((record, self) => {
    const successor = record.successorId ? byId.get(record.successorId) : undefined;

    return successor ? self(successor) : record;
  });

  const callerOf = (record: AgentRecord): AgentRecord | undefined => {
    const callerId = firstLink(record).callerId;
    const caller = callerId === MAIN_CALLER ? undefined : byId.get(callerId);

    return caller ? lastLink(caller) : undefined;
  };

  const isListRoot = (record: AgentRecord): boolean => {
    const caller = callerOf(record);

    return !caller || (!isClosed(record.state) && isClosed(caller.state));
  };

  const rootOf = memoised((record, self) => {
    const caller = callerOf(record);

    return !caller || isListRoot(record) ? record : self(caller);
  });

  return { byId, terminals, callerOf, isListRoot, rootOf };
};

const newestFirst = (a: AgentRecord, b: AgentRecord) => (b.endedAt ?? 0) - (a.endedAt ?? 0);

export const MAX_CLOSED_ROOTS = 200;

export const visibleRecords = (records: AgentRecord[], cleared: ReadonlySet<string>): AgentRecord[] => {
  const { byId, terminals, callerOf, isListRoot, rootOf } = forestOf(records);
  const hidden = (record: AgentRecord) => isClosed(record.state) && cleared.has(record.id);

  const keptRoots = new Set(
    terminals
      .filter((record) => isClosed(record.state) && !hidden(record) && isListRoot(record))
      .sort(newestFirst)
      .slice(0, MAX_CLOSED_ROOTS)
      .map((record) => record.id),
  );

  const listedAlone = (record: AgentRecord) => {
    if (!isClosed(record.state)) {
      return true;
    }

    const root = rootOf(record);

    return !isClosed(root.state) || keptRoots.has(root.id);
  };

  const listed = new Set<string>();

  const keep = (record: AgentRecord) => {
    if (listed.has(record.id) || hidden(record)) {
      return;
    }

    listed.add(record.id);

    const caller = isListRoot(record) ? undefined : callerOf(record);

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

export const listedTerminals = (visible: AgentRecord[]): AgentRecord[] => {
  const byId = indexOf(visible);

  return visible.filter((record) => isTerminal(record, byId));
};

export const listCounts = (visible: AgentRecord[]): { running: number; finished: number } => {
  const { terminals, isListRoot } = forestOf(visible);

  return {
    running: terminals.filter((record) => !isClosed(record.state)).length,
    finished: terminals.filter((record) => isListRoot(record) && isClosed(record.state)).length,
  };
};

export const countsText = (running: number, finished: number): string =>
  [running > 0 ? `${running} running` : undefined, finished > 0 ? `${finished} finished` : undefined]
    .filter((part) => part !== undefined)
    .join(DOT);

export const listSections = (visible: AgentRecord[]): ListSection[] => {
  const { byId, terminals, isListRoot, rootOf } = forestOf(visible);
  const subtrees = new Map<string, AgentRecord[]>();
  const running: AgentRecord[] = [];

  terminals.forEach((record) => {
    const root = rootOf(record);

    if (!isClosed(root.state)) {
      running.push(record);
      return;
    }

    const subtree = subtrees.get(root.id) ?? [];

    subtree.push(record);
    subtrees.set(root.id, subtree);
  });

  const completedRoots = terminals
    .filter((record) => isListRoot(record) && isClosed(record.state))
    .sort(newestFirst);

  const completed = completedRoots.flatMap((root) =>
    treeOrder(withLinks(subtrees.get(root.id) ?? [], byId), (record) => record.id === root.id),
  );

  const sections: ListSection[] = [
    { title: "Running", rows: treeOrder(withLinks(running, byId), isListRoot) },
    { title: `Finished (${completedRoots.length})`, rows: completed },
  ];

  return sections.filter((section) => section.rows.length > 0);
};

export const subtitle = (visible: AgentRecord[]): string => {
  const { running, finished } = listCounts(visible);
  const text = countsText(running, finished);

  return text && DOT + text;
};

export const clearTargets = (id: string, visible: AgentRecord[]): string[] => {
  const { terminals, callerOf, isListRoot } = forestOf(visible);
  const target = terminals.find((record) => record.id === id);

  if (!target || !isClosed(target.state)) {
    return [];
  }

  const memo = new Map<string, boolean>();

  const below = (record: AgentRecord): boolean => {
    const known = memo.get(record.id);

    if (known !== undefined) {
      return known;
    }

    const caller = isListRoot(record) ? undefined : callerOf(record);
    const found = caller !== undefined && (caller.id === id || below(caller));

    memo.set(record.id, found);

    return found;
  };

  return [
    id,
    ...terminals
      .filter((record) => record.id !== id && isClosed(record.state) && below(record))
      .map((r) => r.id),
  ];
};
