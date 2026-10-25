import type { ContextSnapshot, Host, ModelInfo } from "../../../platform/pi-adapter/index.ts";
import {
  AGENTS_HINT_KEY,
  SPENDING_STATUS_KEY,
  type SpendingTotals,
  sessionCacheHit,
} from "../../../platform/shared/index.ts";

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
    .filter(([key]) => key !== SPENDING_STATUS_KEY && key !== AGENTS_HINT_KEY)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0);

export const agentsHint = (statuses: ReadonlyMap<string, string>): string | undefined => {
  const text = statuses.get(AGENTS_HINT_KEY)?.trim();

  return text || undefined;
};

export type ContextBase = { base: number; warnAt: number; errorAt: number };

export const contextBase = (state: FooterState): ContextBase => ({
  base: state.context.window,
  warnAt: state.context.window * 0.7,
  errorAt: state.context.window * 0.9,
});
