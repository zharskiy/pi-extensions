import type { UsageTotals } from "../adapter/contract.ts";

export const BUSY_CHANNEL = "session-limits:busy";

export const USAGE_CHANNEL = "spending:usage";

type BusySignal = { source: string; busy: boolean };

export type UsageReport = { source: string; id: string; usage: UsageTotals };

const COUNTS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

const COSTS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isAmount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;

const isLabel = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isUsage = (value: unknown): value is UsageTotals => {
  if (!isRecord(value) || !isRecord(value.cost)) {
    return false;
  }

  const cost = value.cost;

  return COUNTS.every((key) => isAmount(value[key])) && COSTS.every((key) => isAmount(cost[key]));
};

export const parseBusySignal = (data: unknown): BusySignal | undefined => {
  if (!isRecord(data) || !isLabel(data.source) || typeof data.busy !== "boolean") {
    return undefined;
  }

  return { source: data.source, busy: data.busy };
};

export const parseUsageReport = (data: unknown): UsageReport | undefined => {
  if (!isRecord(data) || !isLabel(data.source) || !isLabel(data.id) || !isUsage(data.usage)) {
    return undefined;
  }

  return { source: data.source, id: data.id, usage: data.usage };
};

export const SPENDING_STATUS_KEY = "pi-spending";

export const TOTALS_CHANNEL = "spending:totals";

export const TOTALS_REQUEST_CHANNEL = "spending:totals:request";

type Spend = { cost: number; tokens: number };

export type SourceSpend = Spend & { source: string };

export type SpendingTotals = { main: Spend; sources: SourceSpend[] };

const isSpend = (value: unknown): value is Spend =>
  isRecord(value) && isAmount(value.cost) && isAmount(value.tokens);

const isSourceSpend = (value: unknown): value is SourceSpend =>
  isRecord(value) && isLabel(value.source) && isSpend(value);

export const parseTotals = (data: unknown): SpendingTotals | undefined => {
  if (!isRecord(data) || !isSpend(data.main) || !Array.isArray(data.sources)) {
    return undefined;
  }

  if (!data.sources.every(isSourceSpend)) {
    return undefined;
  }

  return {
    main: { cost: data.main.cost, tokens: data.main.tokens },
    sources: data.sources.map(({ source, cost, tokens }) => ({ source, cost, tokens })),
  };
};
