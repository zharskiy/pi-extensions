import { addUsage, emptyUsage, type UsageTotals } from "./contract.ts";

type RawUsage = Partial<Omit<UsageTotals, "cost">> & { cost?: Partial<UsageTotals["cost"]> };

type RawEntry = {
  type?: string;
  usage?: RawUsage;
  message?: { role?: string; usage?: RawUsage };
};

export const normalizeUsage = (raw: RawUsage | undefined): UsageTotals => {
  if (!raw) {
    return emptyUsage();
  }

  const cost = raw.cost ?? {};

  return {
    input: raw.input ?? 0,
    output: raw.output ?? 0,
    cacheRead: raw.cacheRead ?? 0,
    cacheWrite: raw.cacheWrite ?? 0,
    totalTokens: raw.totalTokens ?? 0,
    cost: {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cacheRead ?? 0,
      cacheWrite: cost.cacheWrite ?? 0,
      total: cost.total ?? 0,
    },
  };
};

const entryUsage = (entry: RawEntry, includeToolResults: boolean): RawUsage | undefined => {
  if (entry.type === "usage") {
    return entry.usage;
  }

  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return entry.usage;
  }

  if (entry.type !== "message") {
    return undefined;
  }

  if (entry.message?.role === "assistant") {
    return entry.message.usage;
  }

  if (includeToolResults && entry.message?.role === "toolResult") {
    return entry.message.usage;
  }

  return undefined;
};

export const sumSessionUsage = (entries: readonly unknown[]): UsageTotals =>
  entries
    .map((entry) => entryUsage(entry as RawEntry, true))
    .filter((usage): usage is RawUsage => usage !== undefined)
    .reduce<UsageTotals>((total, usage) => addUsage(total, normalizeUsage(usage)), emptyUsage());

export const sumOwnUsage = (entries: readonly unknown[]): UsageTotals =>
  entries
    .map((entry) => entryUsage(entry as RawEntry, false))
    .filter((usage): usage is RawUsage => usage !== undefined)
    .reduce<UsageTotals>((total, usage) => addUsage(total, normalizeUsage(usage)), emptyUsage());
