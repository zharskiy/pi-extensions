import { addUsage, emptyUsage, type UsageTotals } from "../../../core/adapter/contract.ts";
import { parseUsageReport, type UsageReport } from "../../../core/manager/channels.ts";

export const USAGE_ENTRY = "pi-spending:usage";

export const FORK_MARKER: UsageReport = { source: "fork", id: "fork", usage: emptyUsage() };

type SourceTotal = { source: string; usage: UsageTotals };

const isAhead = (candidate: UsageTotals, current: UsageTotals | undefined) => {
  if (!current) {
    return true;
  }

  return candidate.cost.total > current.cost.total || candidate.totalTokens > current.totalTokens;
};

const keyOf = (source: string, id: string) => JSON.stringify([source, id]);

export const createLedger = (append: (customType: string, data: unknown) => void) => {
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
      append(USAGE_ENTRY, report);
    });

    return changed.length;
  };

  const absorb = (entries: readonly unknown[], idPrefix = "") => {
    const reports = entries
      .map(parseUsageReport)
      .filter((report): report is UsageReport => report !== undefined);
    const afterFork = reports.slice(reports.findLastIndex((report) => report.id === FORK_MARKER.id) + 1);

    afterFork.forEach((report) => {
      keep({ ...report, id: idPrefix + report.id });
    });
  };

  const restore = (entries: readonly unknown[]) => {
    absorb(entries);

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

  return { record: keep, persist, absorb, restore, totals };
};
