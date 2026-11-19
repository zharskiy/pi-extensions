import { pathKey } from "./path-key.ts";

export type Member = {
  file: string;
  mtime: number;
  id?: string;
  bytes: number;
  parent?: string;
  live: boolean;
  pinned?: boolean;
};

export type Chain<M extends Member = Member> = { members: M[]; newest: number; live: boolean };

const linked = (members: readonly Member[]) => {
  const keys = new Set(members.map((member) => pathKey(member.file)));
  const links = new Map<string, string[]>();

  const link = (from: string, to: string) => {
    const known = links.get(from);

    if (known) {
      known.push(to);
      return;
    }

    links.set(from, [to]);
  };

  members.forEach((member) => {
    const child = pathKey(member.file);
    const parent = member.parent === undefined ? undefined : pathKey(member.parent);

    if (parent === undefined || parent === child || !keys.has(parent)) {
      return;
    }

    link(child, parent);
    link(parent, child);
  });

  return links;
};

export const chainsOf = <M extends Member>(members: readonly M[]): Chain<M>[] => {
  const links = linked(members);
  const groupOf = new Map<string, number>();

  const spread = (frontier: string[], group: number): void => {
    if (frontier.length === 0) {
      return;
    }

    const next = frontier
      .flatMap((key) => links.get(key) ?? [])
      .filter((key) => {
        if (groupOf.has(key)) {
          return false;
        }

        groupOf.set(key, group);

        return true;
      });

    spread(next, group);
  };

  members.forEach((member, index) => {
    const key = pathKey(member.file);

    if (groupOf.has(key)) {
      return;
    }

    groupOf.set(key, index);
    spread([key], index);
  });

  const groups = new Map<number, M[]>();

  members.forEach((member) => {
    const group = groupOf.get(pathKey(member.file)) ?? -1;
    const found = groups.get(group);

    if (found) {
      found.push(member);
      return;
    }

    groups.set(group, [member]);
  });

  return [...groups.values()].map((chained) => ({
    members: chained,
    newest: chained.reduce((newest, member) => Math.max(newest, member.mtime), -Infinity),
    live: chained.some((member) => member.live || member.pinned === true),
  }));
};
