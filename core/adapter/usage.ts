import { addUsage, type ContextSnapshot, emptyUsage, type UsageTotals } from "./contract.ts";

type RawEntry = {
  type: string;
  usage?: UsageTotals;
  message?: { role: string; usage?: UsageTotals };
};

const entryUsage = (entry: RawEntry) => {
  if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
    return entry.usage;
  }

  if (entry.type !== "message") {
    return undefined;
  }

  return entry.message?.role === "assistant" || entry.message?.role === "toolResult"
    ? entry.message.usage
    : undefined;
};

export const sumUsage = (entries: readonly unknown[]): UsageTotals =>
  entries
    .map((entry) => entryUsage(entry as RawEntry))
    .filter((usage) => usage !== undefined)
    .reduce(addUsage, emptyUsage());

type ContextSource = {
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
};

export const contextOf = (source: ContextSource): ContextSnapshot => {
  const usage = source.getContextUsage();

  return {
    tokens: usage?.tokens ?? null,
    window: usage?.contextWindow ?? 0,
    percent: usage?.percent ?? null,
  };
};
