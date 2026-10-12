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
