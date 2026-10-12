import type { Host } from "../../../core/adapter/contract.ts";
import { parseUsageReport, USAGE_CHANNEL } from "../../../core/manager/channels.ts";
import { footerText, isVisible } from "./footer.ts";
import { createLedger } from "./ledger.ts";

export const STATUS_KEY = "pi-spending";

export const createSpending = (host: Host) => {
  const ledger = createLedger({
    append: (customType, data) => host.appendEntry(customType, data),
    read: (customType) => host.readEntries(customType),
  });

  const figures = () => {
    const sources = ledger.totals().map(({ source, usage }) => ({ source, cost: usage.cost.total }));

    return {
      main: host.sessionUsage().cost.total,
      sources,
      subscription: host.session()?.subscription ?? false,
    };
  };

  const refresh = () => {
    const current = figures();

    host.ui.setStatus(STATUS_KEY, isVisible(current.sources) ? footerText(current) : undefined);
  };

  host.subscribe(USAGE_CHANNEL, (data) => {
    const report = parseUsageReport(data);

    if (!report || !ledger.record(report)) {
      return;
    }

    refresh();
  });

  host.onSessionStart(() => {
    ledger.clear();
    ledger.restore();
    refresh();
  });

  host.onIdle(() => {
    ledger.persist();
    refresh();
  });

  host.onSessionShutdown(() => {
    ledger.persist();
  });
};
