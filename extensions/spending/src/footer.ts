import { formatCost } from "../../../core/manager/format.ts";
import { DOT } from "../../../core/manager/layout.ts";

type SourceCost = { source: string; cost: number };

const money = (usd: number) => formatCost(usd, { zero: "show" }) ?? "$0.00";

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
    `main ${money(main)}`,
    ...sources.map((entry) => `${entry.source} ${money(entry.cost)}`),
    `total ${money(total)}`,
  ];

  return `${parts.join(DOT)}${suffix}`;
};
