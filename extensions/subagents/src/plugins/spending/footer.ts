import { formatCost } from "../../components/agent-row.ts";

export type SpendFigures = { main: number; agents: number; subscription: boolean };

export const footerText = (figures: SpendFigures) => {
  const suffix = figures.subscription ? " (sub)" : "";
  const total = figures.main + figures.agents;

  return `main ${formatCost(figures.main)} · agents ${formatCost(figures.agents)} · total ${formatCost(total)}${suffix}`;
};
