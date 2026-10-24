import type { Host } from "../../../platform/pi-adapter/index.ts";
import { parseTotals, type SpendingTotals, TOTALS_CHANNEL } from "../../../platform/shared/index.ts";

export const watchTotals = (host: Host, changed: () => void) => {
  let totals: SpendingTotals | undefined;

  host.subscribe(TOTALS_CHANNEL, (data) => {
    const parsed = parseTotals(data);

    if (!parsed) {
      return;
    }

    totals = parsed;
    changed();
  });

  return () => totals;
};
