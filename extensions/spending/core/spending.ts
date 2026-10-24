import { basename } from "node:path";
import type { Host, UsageTotals } from "../../../platform/pi-adapter/index.ts";
import { parseUsageReport, type SpendingTotals } from "../../../platform/shared/index.ts";
import { CONTINUATION_MARKER, createLedger, USAGE_ENTRY } from "./ledger.ts";

const MAIN_OFFSET_ENTRY = "pi-spending:main-offset";

const MAIN_TOKENS_OFFSET_ENTRY = "pi-spending:main-tokens-offset";

const chargeable = (usage: UsageTotals) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

export const createSpending = (host: Host) => {
  let costOffset = 0;
  let tokensOffset = 0;

  const ledger = createLedger((customType, data) => host.appendEntry(customType, data));

  const lastOffset = (customType: string, file?: string) => {
    const value = host.readEntries<unknown>(customType, file).at(-1);

    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };

  const resume = () => {
    costOffset = lastOffset(MAIN_OFFSET_ENTRY);
    tokensOffset = lastOffset(MAIN_TOKENS_OFFSET_ENTRY);
    ledger.restore(host.readEntries(USAGE_ENTRY));
  };

  const readParent = (parent: string) => {
    try {
      return {
        usage: host.sessionUsage(parent),
        cost: lastOffset(MAIN_OFFSET_ENTRY, parent),
        tokens: lastOffset(MAIN_TOKENS_OFFSET_ENTRY, parent),
        reports: host.readEntries(USAGE_ENTRY, parent),
      };
    } catch {
      return undefined;
    }
  };

  const inherit = (parent: string) => {
    const previous = readParent(parent);

    if (!previous) {
      host.ui.notify(
        `spending: could not read the parent session ${basename(parent)}; totals cover this session only`,
        "warning",
      );
      resume();
      return;
    }

    const own = host.sessionUsage();

    costOffset = previous.cost + previous.usage.cost.total - own.cost.total;
    tokensOffset = previous.tokens + chargeable(previous.usage) - chargeable(own);
    host.appendEntry(MAIN_OFFSET_ENTRY, costOffset);
    host.appendEntry(MAIN_TOKENS_OFFSET_ENTRY, tokensOffset);
    host.appendEntry(USAGE_ENTRY, CONTINUATION_MARKER);
    ledger.absorb(previous.reports, `${basename(parent)}/`);
    ledger.persist();
  };

  const restore = (parent?: string) => {
    if (parent) {
      inherit(parent);
    } else {
      resume();
    }
  };

  const record = (data: unknown) => {
    const report = parseUsageReport(data);

    if (!report || !ledger.record(report)) {
      return false;
    }

    if (host.isIdle()) {
      ledger.persist();
    }

    return true;
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

  return { restore, record, totals, persist: ledger.persist };
};
