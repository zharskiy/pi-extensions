import { basename } from "node:path";

import type { Host } from "../../../core/adapter/contract.ts";
import { parseUsageReport, USAGE_CHANNEL } from "../../../core/manager/channels.ts";
import { footerText } from "./footer.ts";
import { CONTINUATION_MARKER, createLedger, USAGE_ENTRY } from "./ledger.ts";

const STATUS_KEY = "pi-spending";

const MAIN_OFFSET_ENTRY = "pi-spending:main-offset";

export const createSpending = (host: Host) => {
  let closed = false;

  const ledger = createLedger((customType, data) => host.appendEntry(customType, data));

  const mainCost = (file?: string) =>
    (host.readEntries<number>(MAIN_OFFSET_ENTRY, file).at(-1) ?? 0) + host.sessionUsage(file).cost.total;

  const inherit = (parent: string) => {
    host.appendEntry(MAIN_OFFSET_ENTRY, mainCost(parent) - host.sessionUsage().cost.total);
    host.appendEntry(USAGE_ENTRY, CONTINUATION_MARKER);
    ledger.absorb(host.readEntries(USAGE_ENTRY, parent), `${basename(parent)}/`);
    ledger.persist();
  };

  const figures = () => {
    const sources = ledger.totals().map(({ source, usage }) => ({ source, cost: usage.cost.total }));

    return {
      main: mainCost(),
      sources,
      subscription: host.session().subscription,
    };
  };

  const refresh = () => {
    host.ui.setStatus(STATUS_KEY, footerText(figures()));
  };

  host.subscribe(USAGE_CHANNEL, (data) => {
    const report = parseUsageReport(data);

    if (closed || !report || !ledger.record(report)) {
      return;
    }

    refresh();
  });

  host.onSessionStart((_info, parent) => {
    if (parent) {
      inherit(parent);
    } else {
      ledger.restore(host.readEntries(USAGE_ENTRY));
    }

    refresh();
  });

  host.onIdle(() => {
    ledger.persist();
    refresh();
  });

  host.onSessionShutdown(() => {
    ledger.persist();
    closed = true;
  });
};
