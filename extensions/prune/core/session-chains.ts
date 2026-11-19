import { pathKey } from "./path-key.ts";

export type Member = {
  file: string;
  mtime: number;
  id?: string;
  bytes: number;
  parent?: string;
  live: boolean;
};

export type Chain<M extends Member = Member> = { members: M[]; newest: number; live: boolean };

const disjoint = (count: number) => {
  const roots = Array.from({ length: count }, (_, node) => node);
  const sizes = roots.map(() => 1);

  const find = (node: number): number => {
    if (roots[node] === node) {
      return node;
    }

    roots[node] = find(roots[node]);

    return roots[node];
  };

  const union = (left: number, right: number) => {
    const [a, b] = [find(left), find(right)];

    if (a === b) {
      return;
    }

    const [big, small] = sizes[a] >= sizes[b] ? [a, b] : [b, a];

    roots[small] = big;
    sizes[big] += sizes[small];
  };

  return { find, union };
};

export const chainsOf = <M extends Member>(members: readonly M[]): Chain<M>[] => {
  const nodes = new Map<string, number>();

  members.forEach((member, index) => {
    const key = pathKey(member.file);

    if (!nodes.has(key)) {
      nodes.set(key, index);
    }
  });

  const sets = disjoint(members.length);
  const nodeOf = (member: M) => nodes.get(pathKey(member.file)) ?? 0;

  members.forEach((member) => {
    const parent = member.parent === undefined ? undefined : nodes.get(pathKey(member.parent));

    if (parent !== undefined) {
      sets.union(nodeOf(member), parent);
    }
  });

  const groups = new Map<number, M[]>();

  members.forEach((member) => {
    const group = sets.find(nodeOf(member));
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
    live: chained.some((member) => member.live),
  }));
};
