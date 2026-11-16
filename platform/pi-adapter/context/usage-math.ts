import type { ContextSnapshot, PromptTokens } from "../types/context.ts";
import { addUsage, emptyUsage, type UsageTotals } from "../types/usage.ts";

type RawUsage = Partial<Omit<UsageTotals, "cost">> & { cost?: Partial<UsageTotals["cost"]> };

type RawEntry = {
  type: string;
  usage?: RawUsage;
  message?: { role: string; usage?: RawUsage };
};

const totalsOf = (usage: RawUsage): UsageTotals => ({
  input: usage.input ?? 0,
  output: usage.output ?? 0,
  cacheRead: usage.cacheRead ?? 0,
  cacheWrite: usage.cacheWrite ?? 0,
  totalTokens: usage.totalTokens ?? 0,
  cost: {
    input: usage.cost?.input ?? 0,
    output: usage.cost?.output ?? 0,
    cacheRead: usage.cost?.cacheRead ?? 0,
    cacheWrite: usage.cost?.cacheWrite ?? 0,
    total: usage.cost?.total ?? 0,
  },
});

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

const assistantUsage = (entry: RawEntry) =>
  entry.type === "message" && entry.message?.role === "assistant" ? entry.message.usage : undefined;

export const sumUsage = (entries: readonly unknown[], usageOf = entryUsage): UsageTotals =>
  entries
    .map((entry) => usageOf(entry as RawEntry))
    .filter((usage) => usage !== undefined)
    .map(totalsOf)
    .reduce(addUsage, emptyUsage());

export const requestUsageOf = (usage: RawUsage | undefined): PromptTokens => {
  const { input, cacheRead, cacheWrite, output } = totalsOf(usage ?? {});

  return { input, cacheRead, cacheWrite, output };
};

export const sumAssistantUsage = (entries: readonly unknown[]): PromptTokens =>
  requestUsageOf(sumUsage(entries, assistantUsage));

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
