import { addUsage, emptyUsage, type UsageTotals } from "../../../core/adapter/contract.ts";

export const USAGE_ENTRY = "pi-spending:usage";

export type UsageReport = { source: string; id: string; usage: UsageTotals };

export type SourceTotal = { source: string; usage: UsageTotals };

export type LedgerStore = {
  append(customType: string, data: unknown): void;
  read<T>(customType: string): T[];
};

const COUNTS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

const COSTS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

const isAmount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isUsage = (value: unknown): value is UsageTotals => {
  if (!isRecord(value) || !isRecord(value.cost)) {
    return false;
  }

  const cost = value.cost;

  return COUNTS.every((key) => isAmount(value[key])) && COSTS.every((key) => isAmount(cost[key]));
};

const isLabel = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export const parseUsageReport = (data: unknown): UsageReport | undefined => {
  if (!isRecord(data)) {
    return undefined;
  }

  const { source, id, usage } = data;

  if (!isLabel(source) || !isLabel(id) || !isUsage(usage)) {
    return undefined;
  }

  return { source, id, usage };
};

export const isAhead = (candidate: UsageTotals, current: UsageTotals | undefined) => {
  if (!current) {
    return true;
  }

  return candidate.cost.total > current.cost.total || candidate.totalTokens > current.totalTokens;
};

const keyOf = (source: string, id: string) => JSON.stringify([source, id]);

export const createLedger = (store: LedgerStore) => {
  const current = new Map<string, UsageReport>();
  const persisted = new Map<string, UsageTotals>();

  const keep = (report: UsageReport) => {
    const key = keyOf(report.source, report.id);

    if (!isAhead(report.usage, current.get(key)?.usage)) {
      return false;
    }

    current.set(key, report);

    return true;
  };

  const persist = () => {
    const changed = Array.from(current, ([key, report]) => ({ key, report })).filter(({ key, report }) =>
      isAhead(report.usage, persisted.get(key)),
    );

    changed.forEach(({ key, report }) => {
      persisted.set(key, report.usage);
      store.append(USAGE_ENTRY, report);
    });

    return changed.length;
  };

  const clear = () => {
    current.clear();
    persisted.clear();
  };

  const restore = () => {
    store
      .read<unknown>(USAGE_ENTRY)
      .map(parseUsageReport)
      .filter((report): report is UsageReport => report !== undefined)
      .forEach(keep);

    current.forEach((report, key) => {
      persisted.set(key, report.usage);
    });
  };

  const totals = (): SourceTotal[] => {
    const bySource = new Map<string, UsageTotals>();

    current.forEach((report) => {
      bySource.set(report.source, addUsage(bySource.get(report.source) ?? emptyUsage(), report.usage));
    });

    return Array.from(bySource, ([source, usage]) => ({ source, usage })).sort((left, right) =>
      left.source.localeCompare(right.source),
    );
  };

  return { record: keep, persist, clear, restore, totals };
};

export type Ledger = ReturnType<typeof createLedger>;
