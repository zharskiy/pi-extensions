export type DiffCounts = { added: number; removed: number };

export const diffCounts = (diff: string): DiffCounts => {
  const changed = diff.split("\n").filter((line) => /^[+-]\s*\d/.test(line));

  return {
    added: changed.filter((line) => line.startsWith("+")).length,
    removed: changed.filter((line) => line.startsWith("-")).length,
  };
};
