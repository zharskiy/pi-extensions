import {
  MIRROR_STATUS_PREFIX,
  type Plugin,
  TOTALS_CHANNEL,
  USAGE_CHANNEL,
} from "../../../platform/shared/index.ts";
import { createSpending } from "../core/spending.ts";
import { footerText } from "../ui/footer-text.ts";

const STATUS_KEY = `${MIRROR_STATUS_PREFIX}spending`;

export const spendingPlugin: Plugin<never, never, undefined> = {
  id: "spending",
  enable({ host }) {
    let closed = false;
    let started = false;

    const spending = createSpending(host);

    const refresh = () => {
      const current = spending.totals();

      host.ui.setStatus(
        STATUS_KEY,
        footerText({ main: current.main.cost, sources: current.sources, subscription: current.subscription }),
      );
      host.publish(TOTALS_CHANNEL, current);
    };

    host.subscribe(USAGE_CHANNEL, (data) => {
      if (closed || !spending.record(data)) {
        return;
      }

      refresh();
    });

    host.onSessionStart((_info, parent) => {
      if (started) {
        refresh();
        return;
      }

      started = true;
      spending.restore(parent);
      refresh();
    });

    host.onTurnEnd(refresh);

    host.onCompact(refresh);

    host.onIdle(() => {
      spending.persist();
      refresh();
    });

    host.onSessionShutdown(() => {
      spending.persist();
      closed = true;
    });

    return undefined;
  },
};
