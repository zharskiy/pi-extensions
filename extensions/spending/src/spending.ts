import { basename } from "node:path";

import type { Host, UsageTotals } from "../../../core/adapter/contract.ts";
import {
  parseUsageReport,
  SPENDING_STATUS_KEY,
  type SpendingTotals,
  TOTALS_CHANNEL,
  USAGE_CHANNEL,
} from "../../../core/manager/channels.ts";
import { footerText } from "./footer.ts";
import { CONTINUATION_MARKER, createLedger, USAGE_ENTRY } from "./ledger.ts";

const MAIN_OFFSET_ENTRY = "pi-spending:main-offset";

const MAIN_TOKENS_OFFSET_ENTRY = "pi-spending:main-tokens-offset";

const chargeable = (usage: UsageTotals) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

export const createSpending = (host: Host) => {
  let closed = false;
  let costOffset = 0;
  let tokensOffset = 0;

  const ledger = createLedger((customType, data) => host.appendEntry(customType, data));

  const lastOffset = (customType: string, file?: string) =>
    host.readEntries<number>(customType, file).at(-1) ?? 0;

  const inherit = (parent: string) => {
    const parentUsage = host.sessionUsage(parent);
    const own = host.sessionUsage();

    costOffset = lastOffset(MAIN_OFFSET_ENTRY, parent) + parentUsage.cost.total - own.cost.total;
    tokensOffset = lastOffset(MAIN_TOKENS_OFFSET_ENTRY, parent) + chargeable(parentUsage) - chargeable(own);
    host.appendEntry(MAIN_OFFSET_ENTRY, costOffset);
    host.appendEntry(MAIN_TOKENS_OFFSET_ENTRY, tokensOffset);
    host.appendEntry(USAGE_ENTRY, CONTINUATION_MARKER);
    ledger.absorb(host.readEntries(USAGE_ENTRY, parent), `${basename(parent)}/`);
    ledger.persist();
  };

  const totals = (): SpendingTotals => {
    const own = host.sessionUsage();

    return {
      main: { cost: costOffset + own.cost.total, tokens: tokensOffset + chargeable(own) },
      sources: ledger
        .totals()
        .map(({ source, usage }) => ({ source, cost: usage.cost.total, tokens: chargeable(usage) })),
      subscription: host.session().subscription,
    };
  };

  const refresh = () => {
    const current = totals();

    host.ui.setStatus(
      SPENDING_STATUS_KEY,
      footerText({ main: current.main.cost, sources: current.sources, subscription: current.subscription }),
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

  host.onSessionStart((_info, parent) => {
    if (parent) {
      inherit(parent);
    } else {
      costOffset = lastOffset(MAIN_OFFSET_ENTRY);
      tokensOffset = lastOffset(MAIN_TOKENS_OFFSET_ENTRY);
      ledger.restore(host.readEntries(USAGE_ENTRY));
    }

    refresh();
  });

  host.onTurnEnd(refresh);

  host.onIdle(() => {
    ledger.persist();
    refresh();
  });

  host.onSessionShutdown(() => {
    ledger.persist();
    closed = true;
  });
};
