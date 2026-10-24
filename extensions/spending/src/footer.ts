import { formatMoney } from "../../../core/manager/format.ts";
import { DOT } from "../../../core/manager/layout.ts";

type SourceCost = { source: string; cost: number };

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
  const total = sources.reduce((sum, entry) => sum + entry.cost, main);

  const parts = [
    `main ${formatMoney(main)}`,
    ...sources.map((entry) => `${entry.source} ${formatMoney(entry.cost)}`),
    `total ${formatMoney(total)}`,
  ];

  return `${parts.join(DOT)}${suffix}`;
};
