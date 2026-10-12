import { watchAgents } from "../../components/refresh.ts";
import type { Plugin } from "../../model/plugin.ts";
import { isClosed } from "../../model/types.ts";
import { createAgentListView } from "./view.ts";

export const agentListViewPlugin: Plugin = {
  id: "agent-list-view",
  requires: ["agent-registry", "agent-view"],
  enable: ({ host, bus, services }) => {
    const registry = services.require("registry");

    const subscribe = (onChange: () => void) =>
      watchAgents(bus, {
        relevant: () => true,
        ticking: () => registry.list().some((record) => !isClosed(record.state)),
        onChange,
      });

    const open = async () => {
      await host.ui.openOverlay((api) =>
        createAgentListView(
          {
            records: () => registry.list(),
            open: (id) => void services.require("agentView").open(id),
            stop: (id) => (services.has("runner") ? services.require("runner").stop(id) : undefined),
            subscribe,
          },
          api,
        ),
      );
    };

    services.provide("agentList", { open });
  },
};
