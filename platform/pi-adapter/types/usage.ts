export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export const emptyUsage = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export const addUsage = (left: UsageTotals, right: UsageTotals): UsageTotals => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  totalTokens: left.totalTokens + right.totalTokens,
  cost: {
    input: left.cost.input + right.cost.input,
    output: left.cost.output + right.cost.output,
    cacheRead: left.cost.cacheRead + right.cost.cacheRead,
    cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
    total: left.cost.total + right.cost.total,
  },
});
