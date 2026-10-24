import { addUsage, emptyUsage, type UsageTotals } from "../../../platform/pi-adapter/index.ts";
import { parseUsageReport, type UsageReport } from "../../../platform/shared/index.ts";

export const USAGE_ENTRY = "pi-spending:usage";

export const CONTINUATION_MARKER: UsageReport = {
  source: "continuation",
  id: "continuation",
  usage: emptyUsage(),
};

type SourceTotal = { source: string; usage: UsageTotals };

const isAhead = (candidate: UsageTotals, current: UsageTotals | undefined) => {
  if (!current) {
    return true;
  }

  const cost = candidate.cost.total - current.cost.total;
  const tokens = candidate.totalTokens - current.totalTokens;

  return cost >= 0 && tokens >= 0 && (cost > 0 || tokens > 0);
};

const isMarker = ({ source, id }: UsageReport) =>
  source === CONTINUATION_MARKER.source && id === CONTINUATION_MARKER.id;

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
    const own = reports.slice(reports.findLastIndex(isMarker) + 1);

    own.forEach((report) => {
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
