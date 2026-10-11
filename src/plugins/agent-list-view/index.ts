import type { Plugin } from "../../manager/plugin.ts";
import { isClosed } from "../../manager/types.ts";
import { createAgentListView } from "./view.ts";

export const REFRESH_MS = 300;

export const TICK_MS = 1_000;

export const agentListViewPlugin: Plugin = {
  id: "agent-list-view",
  requires: ["agent-registry", "agent-view"],
  enable: ({ host, bus, services }) => {
    const registry = services.require("registry");

    const subscribe = (onChange: () => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const scheduled = () => {
        if (timer) {
          return;
        }

        timer = setTimeout(() => {
          timer = undefined;
          onChange();
        }, REFRESH_MS);
      };

      const off = bus.on("agent:changed", scheduled);
      const ticker = setInterval(() => {
        if (registry.list().some((record) => !isClosed(record.state))) {
          onChange();
        }
      }, TICK_MS);

      return () => {
        off();
        clearInterval(ticker);

        if (timer) {
          clearTimeout(timer);
        }
      };
    };

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

    return undefined;
  },
};
