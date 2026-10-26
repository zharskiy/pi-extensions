import type { UsageTotals } from "../../pi-adapter/index.ts";
import type { Limits } from "../handoff/handoff-budget.ts";
import { isPlainObject } from "../plain-object.ts";

export const BUSY_CHANNEL = "pi:busy";

export const USAGE_CHANNEL = "spending:usage";

export const AWAITING_INPUT_CHANNEL = "pi:awaiting-input";

type BusySignal = { source: string; busy: boolean };

export type AwaitingInput = { source: string; waiting: boolean; title?: string };

export type UsageReport = { source: string; id: string; usage: UsageTotals };

const COUNTS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

const COSTS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

const isAmount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;

const isLabel = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isUsage = (value: unknown): value is UsageTotals => {
  if (!isPlainObject(value) || !isPlainObject(value.cost)) {
    return false;
  }

  const cost = value.cost;

  return COUNTS.every((key) => isAmount(value[key])) && COSTS.every((key) => isAmount(cost[key]));
};

export const parseBusySignal = (data: unknown): BusySignal | undefined => {
  if (!isPlainObject(data) || !isLabel(data.source) || typeof data.busy !== "boolean") {
    return undefined;
  }

  return { source: data.source, busy: data.busy };
};

export const parseAwaitingInput = (data: unknown): AwaitingInput | undefined => {
  if (!isPlainObject(data) || !isLabel(data.source) || typeof data.waiting !== "boolean") {
    return undefined;
  }

  if (data.title !== undefined && typeof data.title !== "string") {
    return undefined;
  }

  return {
    source: data.source,
    waiting: data.waiting,
    ...(isLabel(data.title) ? { title: data.title } : {}),
  };
};

export const parseUsageReport = (data: unknown): UsageReport | undefined => {
  if (!isPlainObject(data) || !isLabel(data.source) || !isLabel(data.id) || !isUsage(data.usage)) {
    return undefined;
  }

  return { source: data.source, id: data.id, usage: data.usage };
};

export const TOTALS_CHANNEL = "spending:totals";

type Spend = { cost: number; tokens: number };

type SourceSpend = Spend & { source: string };

export type SpendingTotals = { main: Spend; sources: SourceSpend[]; subscription: boolean };

const isSpend = (value: unknown): value is Spend =>
  isPlainObject(value) && isAmount(value.cost) && isAmount(value.tokens);

const isSourceSpend = (value: unknown): value is SourceSpend =>
  isPlainObject(value) && isLabel(value.source) && isSpend(value);

export const parseTotals = (data: unknown): SpendingTotals | undefined => {
  if (
    !isPlainObject(data) ||
    !isSpend(data.main) ||
    !Array.isArray(data.sources) ||
    typeof data.subscription !== "boolean"
  ) {
    return undefined;
  }

  if (!data.sources.every(isSourceSpend)) {
    return undefined;
  }

  return {
    main: { cost: data.main.cost, tokens: data.main.tokens },
    sources: data.sources.map(({ source, cost, tokens }) => ({ source, cost, tokens })),
    subscription: data.subscription,
  };
};

export const LIMITS_CHANNEL = "session-limits:limits";

const isPositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isRatio = (value: unknown): value is number => isPositive(value) && value <= 1;

export const parseLimits = (data: unknown): Limits | undefined => {
  if (
    !isPlainObject(data) ||
    !isRatio(data.softRatio) ||
    !isRatio(data.hardRatio) ||
    !isPositive(data.softTokens) ||
    !isPositive(data.hardTokens)
  ) {
    return undefined;
  }

  return {
    softRatio: data.softRatio,
    hardRatio: data.hardRatio,
    softTokens: data.softTokens,
    hardTokens: data.hardTokens,
  };
};
