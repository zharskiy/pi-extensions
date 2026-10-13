import { type AgentRecord, isClosed } from "../model/types.ts";

export type TreeRow = {
  record: AgentRecord;
  depth: number;
  last: boolean;
  ancestorsContinue: boolean[];
  openDescendants: number;
};

export const treeOrder = (records: AgentRecord[], roots?: (record: AgentRecord) => boolean): TreeRow[] => {
  const byId = new Map(records.map((record) => [record.id, record]));

  const terminalOf = (record: AgentRecord): AgentRecord => {
    const successor = record.successorId ? byId.get(record.successorId) : undefined;

    return successor ? terminalOf(successor) : record;
  };

  const firstLinkOf = (record: AgentRecord): AgentRecord => {
    const predecessor = record.predecessorId ? byId.get(record.predecessorId) : undefined;

    return predecessor ? firstLinkOf(predecessor) : record;
  };

  const parentOf = (terminal: AgentRecord) => {
    if (roots?.(terminal)) {
      return undefined;
    }

    const caller = byId.get(firstLinkOf(terminal).callerId);

    return caller ? terminalOf(caller).id : undefined;
  };

  const terminals = records.filter((record) => !record.successorId || !byId.has(record.successorId));
  const children = new Map<string | undefined, AgentRecord[]>();

  terminals.forEach((terminal) => {
    const parent = parentOf(terminal);
    const siblings = children.get(parent) ?? [];

    siblings.push(terminal);
    children.set(parent, siblings);
  });

  children.forEach((siblings) => {
    siblings.sort((a, b) => firstLinkOf(a).createdAt - firstLinkOf(b).createdAt);
  });

  const rows: TreeRow[] = [];

  const walk = (parentId: string | undefined, depth: number, continues: boolean[]): number => {
    const siblings = children.get(parentId) ?? [];

    return siblings.reduce((open, record, index) => {
      const last = index === siblings.length - 1;
      const row: TreeRow = { record, depth, last, ancestorsContinue: continues, openDescendants: 0 };

      rows.push(row);

      const below = depth === 0 ? [] : [...continues, !last];

      row.openDescendants = walk(record.id, depth + 1, below);

      return open + row.openDescendants + (isClosed(record.state) ? 0 : 1);
    }, 0);
  };

  walk(undefined, 0, []);

  return rows;
};
