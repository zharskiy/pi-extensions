import type { ContextSnapshot, Host, ModelInfo } from "../../../pi-adapter/index.ts";
import { SPENDING_STATUS_KEY, type SpendingTotals, sessionCacheHit } from "../../../shared/index.ts";

export type FooterState = {
  context: ContextSnapshot;
  model: ModelInfo | undefined;
  thinking: string;
  cycleKey: string;
  cwd: string;
  sessionName: string | undefined;
  totals: SpendingTotals | undefined;
  cache: number | undefined;
};

export const footerState = (
  host: Host,
  cwd: string,
  cycleKey: string,
  totals: SpendingTotals | undefined,
): FooterState => ({
  context: host.context(),
  model: host.model(),
  thinking: host.thinkingLevel(),
  cycleKey,
  cwd,
  sessionName: host.sessionName(),
  totals,
  cache: sessionCacheHit(host.mainRequestUsage()),
});

export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export const sessionSpend = (totals: SpendingTotals) => {
  const all = [totals.main, ...totals.sources];

  return {
    tokens: all.reduce((sum, spend) => sum + spend.tokens, 0),
    cost: all.reduce((sum, spend) => sum + spend.cost, 0),
  };
};

export const statusLines = (statuses: ReadonlyMap<string, string>): string[] =>
  Array.from(statuses)
    .filter(([key]) => key !== SPENDING_STATUS_KEY)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0);
