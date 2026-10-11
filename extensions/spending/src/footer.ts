export type SourceCost = { source: string; cost: number };

export type SpendFigures = { main: number; sources: SourceCost[]; subscription: boolean };

export const formatCost = (usd: number) => `$${usd.toFixed(3)}`;

export const isVisible = (sources: SourceCost[]) => sources.some((entry) => entry.cost > 0);

export const footerText = ({ main, sources, subscription }: SpendFigures) => {
  const suffix = subscription ? " (sub)" : "";
  const total = sources.reduce((sum, entry) => sum + entry.cost, main);

  const parts = [
    `main ${formatCost(main)}`,
    ...sources.map((entry) => `${entry.source} ${formatCost(entry.cost)}`),
    `total ${formatCost(total)}`,
  ];

  return `${parts.join(" · ")}${suffix}`;
};
