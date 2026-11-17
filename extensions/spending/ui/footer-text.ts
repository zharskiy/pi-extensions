import { DOT, formatMoney, type SpendingTotals, sessionSpend } from "../../../platform/shared/index.ts";

export const footerText = (totals: SpendingTotals) => {
  if (!totals.sources.some((entry) => entry.cost > 0)) {
    return undefined;
  }

  const suffix = totals.subscription ? " (sub)" : "";

  const parts = [
    `main ${formatMoney(totals.main.cost)}`,
    ...totals.sources.map((entry) => `${entry.source} ${formatMoney(entry.cost)}`),
    `total ${formatMoney(sessionSpend(totals).cost)}`,
  ];

  return `${parts.join(DOT)}${suffix}`;
};
