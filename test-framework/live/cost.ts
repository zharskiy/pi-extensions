import type { UsageTotals } from "../../pi-adapter/index.ts";

export const totalCost = (usages: Iterable<UsageTotals>) =>
  Array.from(usages).reduce((sum, usage) => sum + usage.cost.total, 0);

export const reportCost = (label: string, cost: number | undefined) => {
  console.log(`[live cost] ${label}: ${cost === undefined ? "unavailable" : `$${cost.toFixed(6)}`}`);
};
