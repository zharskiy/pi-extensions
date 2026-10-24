import { USAGE_CHANNEL } from "../../../../../shared/index.ts";
import type { Plugin } from "../../model/plugin.ts";

export const usageReportPlugin: Plugin = {
  id: "usage-report",
  requires: ["run-agent"],
  enable: ({ host, bus }) =>
    bus.on("agent:usage", ({ id, usage }) => {
      host.publish(USAGE_CHANNEL, { source: "agents", id, usage });
    }),
};
