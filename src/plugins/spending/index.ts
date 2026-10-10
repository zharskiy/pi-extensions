import type { Plugin } from "../../manager/plugin.ts";
import { footerText } from "./footer.ts";
import { createLedger } from "./ledger.ts";

export const STATUS_KEY = "pi-subagents-spend";

export const spendingPlugin: Plugin = {
  id: "spending",
  enable: ({ host, bus, services }) => {
    const closedIds = new Set<string>();

    const refresh = () => {
      const agents = ledger.agentsTotal().cost.total;

      if (agents <= 0) {
        host.ui.setStatus(STATUS_KEY, undefined);
        return;
      }

      const main = host.sessionUsage().cost.total - ledger.deliveredTotal().cost.total;
      const subscription = host.session()?.subscription ?? false;

      host.ui.setStatus(STATUS_KEY, footerText({ main, agents, subscription }));
    };

    const ledger = createLedger(
      {
        append: (customType, data) => host.appendEntry(customType, data),
        read: (customType) => host.readEntries(customType),
      },
      () => refresh(),
    );

    services.provide("ledger", ledger);

    const offUsage = bus.on("agent:usage", ({ id, usage }) => {
      ledger.record(id, usage);

      if (closedIds.has(id)) {
        ledger.persist(id);
      }
    });

    const offClosed = bus.on("agent:closed", (record) => {
      closedIds.add(record.id);
      ledger.persist(record.id);
    });

    host.onSessionStart(() => {
      ledger.restore();
      refresh();
    });

    host.onIdle(refresh);

    return () => {
      offUsage();
      offClosed();
    };
  },
};
