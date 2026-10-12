import { addUsage, type ContextSnapshot, emptyUsage, type UsageTotals } from "./contract.ts";

type RawUsage = Partial<Omit<UsageTotals, "cost">> & { cost?: Partial<UsageTotals["cost"]> };

type RawEntry = {
  type?: string;
  usage?: RawUsage;
  message?: { role?: string; usage?: RawUsage };
};

const normalizeUsage = (raw: RawUsage | undefined): UsageTotals => {
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

const entryUsage = (entry: RawEntry): RawUsage | undefined => {
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
    .filter((usage): usage is RawUsage => usage !== undefined)
    .reduce<UsageTotals>((total, usage) => addUsage(total, normalizeUsage(usage)), emptyUsage());

type ContextSource = {
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  readonly model?: { contextWindow: number };
};

export const contextOf = (source: ContextSource): ContextSnapshot => {
  const usage = source.getContextUsage();
  const window = usage?.contextWindow ?? source.model?.contextWindow ?? 0;

  return { tokens: usage?.tokens ?? null, window, percent: usage?.percent ?? null };
};
