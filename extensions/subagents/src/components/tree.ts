import { type AgentRecord, chainLinks, chainTerminal, isClosed } from "../model/types.ts";

export type TreeRow = {
  record: AgentRecord;
  depth: number;
  last: boolean;
  ancestorsContinue: boolean[];
  openDescendants: number;
};

type ById = ReadonlyMap<string, AgentRecord>;

export const isTerminal = (record: AgentRecord, byId: ById): boolean =>
  !record.successorId || !byId.has(record.successorId);

export const stoppableAgents = (records: AgentRecord[]): AgentRecord[] => {
  const byId = new Map(records.map((record) => [record.id, record]));

  return records.filter(
    (record) => isTerminal(record, byId) && (record.state === "queued" || record.state === "running"),
  );
};

export const withLinks = (records: AgentRecord[], byId: ById): AgentRecord[] => {
  const listed = new Map(records.map((record) => [record.id, record]));

  records
    .flatMap((record) => chainLinks(byId, record))
    .forEach((link) => {
      listed.set(link.id, link);
    });

  return [...listed.values()];
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

export const treeOrder = (records: AgentRecord[], roots?: (record: AgentRecord) => boolean): TreeRow[] => {
  const byId = new Map(records.map((record) => [record.id, record]));

  const firstLinkOf = (record: AgentRecord): AgentRecord => chainLinks(byId, record)[0];

  const parentOf = (terminal: AgentRecord) => {
    if (roots?.(terminal)) {
      return undefined;
    }

    const caller = byId.get(firstLinkOf(terminal).callerId);

    return caller ? chainTerminal(byId, caller).id : undefined;
  };

  const terminals = records.filter((record) => isTerminal(record, byId));
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
