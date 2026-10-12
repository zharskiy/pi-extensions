import { addUsage, emptyUsage, type UsageTotals } from "../../../core/adapter/contract.ts";
import { parseUsageReport, type UsageReport } from "../../../core/manager/channels.ts";

export const USAGE_ENTRY = "pi-spending:usage";

type SourceTotal = { source: string; usage: UsageTotals };

type LedgerStore = {
  append(customType: string, data: unknown): void;
  read<T>(customType: string): T[];
};

const isAhead = (candidate: UsageTotals, current: UsageTotals | undefined) => {
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
