import type { UsageTotals } from "../../../../../core/adapter/contract.ts";
import type { Plugin } from "../../model/plugin.ts";

export const SPENDING_CHANNEL = "spending:usage";

export const SPENDING_SOURCE = "agents";

const isAhead = (candidate: UsageTotals, current: UsageTotals | undefined) => {
  if (!current) {
    return true;
  }

  return candidate.cost.total > current.cost.total || candidate.totalTokens > current.totalTokens;
};

export const usageReportPlugin: Plugin = {
  id: "usage-report",
  requires: ["run-agent"],
  enable: ({ host, bus }) => {
    const published = new Map<string, UsageTotals>();
    let runtimeToken = Date.now().toString(36);

    host.onSessionStart(() => {
      runtimeToken = Date.now().toString(36);
      published.clear();
    });

    return bus.on("agent:usage", ({ id, usage }) => {
      if (!isAhead(usage, published.get(id))) {
        return;
      }

      published.set(id, usage);
      host.publish(SPENDING_CHANNEL, { source: SPENDING_SOURCE, id: `${runtimeToken}/${id}`, usage });
    });
  },
};
