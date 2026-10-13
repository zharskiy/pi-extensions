import { basename } from "node:path";

import type { Host, UsageTotals } from "../../../core/adapter/contract.ts";
import {
  parseUsageReport,
  SPENDING_STATUS_KEY,
  type SpendingTotals,
  TOTALS_CHANNEL,
  TOTALS_REQUEST_CHANNEL,
  USAGE_CHANNEL,
} from "../../../core/manager/channels.ts";
import { footerText } from "./footer.ts";
import { CONTINUATION_MARKER, createLedger, USAGE_ENTRY } from "./ledger.ts";

const MAIN_OFFSET_ENTRY = "pi-spending:main-offset";

const MAIN_TOKENS_OFFSET_ENTRY = "pi-spending:main-tokens-offset";

const chargeable = (usage: UsageTotals) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

export const createSpending = (host: Host) => {
  let closed = false;

  const ledger = createLedger((customType, data) => host.appendEntry(customType, data));

  const mainCost = (file?: string) =>
    (host.readEntries<number>(MAIN_OFFSET_ENTRY, file).at(-1) ?? 0) + host.sessionUsage(file).cost.total;

  const mainTokens = (file?: string) =>
    (host.readEntries<number>(MAIN_TOKENS_OFFSET_ENTRY, file).at(-1) ?? 0) +
    chargeable(host.sessionUsage(file));

  const inherit = (parent: string) => {
    host.appendEntry(MAIN_OFFSET_ENTRY, mainCost(parent) - host.sessionUsage().cost.total);
    host.appendEntry(MAIN_TOKENS_OFFSET_ENTRY, mainTokens(parent) - chargeable(host.sessionUsage()));
    host.appendEntry(USAGE_ENTRY, CONTINUATION_MARKER);
    ledger.absorb(host.readEntries(USAGE_ENTRY, parent), `${basename(parent)}/`);
    ledger.persist();
  };

  const totals = (): SpendingTotals => ({
    main: { cost: mainCost(), tokens: mainTokens() },
    sources: ledger
      .totals()
      .map(({ source, usage }) => ({ source, cost: usage.cost.total, tokens: chargeable(usage) })),
  });

  const refresh = () => {
    const current = totals();

    host.ui.setStatus(
      SPENDING_STATUS_KEY,
      footerText({
        main: current.main.cost,
        sources: current.sources,
        subscription: host.session().subscription,
      }),
    );
    host.publish(TOTALS_CHANNEL, current);
  };

  host.subscribe(USAGE_CHANNEL, (data) => {
    const report = parseUsageReport(data);

    if (closed || !report || !ledger.record(report)) {
      return;
    }

    refresh();
  });

  host.subscribe(TOTALS_REQUEST_CHANNEL, () => {
    if (closed) {
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
