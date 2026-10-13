type SourceCost = { source: string; cost: number };

const rounded = (usd: number) => Number(usd.toFixed(3));

const formatCost = (usd: number) => `$${usd.toFixed(3)}`;

export const footerText = ({
  main,
  sources,
  subscription,
}: {
  main: number;
  sources: SourceCost[];
  subscription: boolean;
}) => {
  if (!sources.some((entry) => entry.cost > 0)) {
    return undefined;
  }

  const suffix = subscription ? " (sub)" : "";
  const total = sources.reduce((sum, entry) => sum + rounded(entry.cost), rounded(main));

  const parts = [
    `main ${formatCost(main)}`,
    ...sources.map((entry) => `${entry.source} ${formatCost(entry.cost)}`),
    `total ${formatCost(total)}`,
  ];

  return `${parts.join(" · ")}${suffix}`;
};
