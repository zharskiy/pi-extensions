import type { ContextSnapshot, Host, ModelInfo } from "../../../platform/pi-adapter/index.ts";
import {
  HINT_STATUS_PREFIX,
  type Limits,
  MIRROR_STATUS_PREFIX,
  type SpendingTotals,
  sessionCacheHit,
  thresholdsFor,
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
  limits: Limits | undefined;
};

export const footerState = (
  host: Host,
  cwd: string,
  cycleKey: string,
  totals: SpendingTotals | undefined,
  limits: Limits | undefined,
): FooterState => ({
  context: host.context(),
  model: host.model(),
  thinking: host.thinkingLevel(),
  cycleKey,
  cwd,
  sessionName: host.sessionName(),
  totals,
  cache: sessionCacheHit(host.mainRequestUsage()),
  limits,
});

export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export const sessionSpend = (totals: SpendingTotals) => {
  const all = [totals.main, ...totals.sources];

  return {
    tokens: all.reduce((sum, spend) => sum + spend.tokens, 0),
    cost: all.reduce((sum, spend) => sum + spend.cost, 0),
  };
};

const statusTexts = (statuses: ReadonlyMap<string, string>, keep: (key: string) => boolean) =>
  Array.from(statuses)
    .filter(([key]) => keep(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0);

export const statusLines = (statuses: ReadonlyMap<string, string>): string[] =>
  statusTexts(
    statuses,
    (key) => !key.startsWith(HINT_STATUS_PREFIX) && !key.startsWith(MIRROR_STATUS_PREFIX),
  );

export const hintTexts = (statuses: ReadonlyMap<string, string>): string[] =>
  statusTexts(statuses, (key) => key.startsWith(HINT_STATUS_PREFIX));

export type ContextBase = { base: number; warnAt?: number; errorAt?: number };

export const contextBase = ({ context, limits }: FooterState): ContextBase => {
  if (limits) {
    const { soft, hard } = thresholdsFor(context.window, limits);

    return { base: hard, warnAt: soft, errorAt: hard };
  }

  return { base: context.window };
};
