import { USAGE_CHANNEL } from "../../../../../core/manager/channels.ts";
import type { Plugin } from "../../model/plugin.ts";

export const SPENDING_SOURCE = "agents";

export const usageReportPlugin: Plugin = {
  id: "usage-report",
  requires: ["run-agent"],
  enable: ({ host, bus }) => {
    return bus.on("agent:usage", ({ id, usage }) => {
      host.publish(USAGE_CHANNEL, { source: SPENDING_SOURCE, id, usage });
    });
  },
};
