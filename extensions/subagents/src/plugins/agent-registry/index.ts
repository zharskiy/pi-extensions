import { BUSY_CHANNEL } from "../../../../../core/manager/channels.ts";
import type { Plugin } from "../../model/plugin.ts";
import { type AgentRegistry, isClosed } from "../../model/types.ts";
import { createRegistry } from "./registry.ts";

const BUSY_SOURCE = "pi-subagents";

const hasOpenAgents = (registry: AgentRegistry) => registry.list().some((record) => !isClosed(record.state));

export const agentRegistryPlugin: Plugin = {
  id: "agent-registry",
  enable: ({ host, bus, services }) => {
    const registry = createRegistry({ bus });
    let busy = false;

    const publish = (next: boolean) => {
      busy = next;
      host.publish(BUSY_CHANNEL, { source: BUSY_SOURCE, busy });
    };

    services.provide("registry", registry);

    const unsubscribe = bus.on("agent:changed", () => {
      const next = hasOpenAgents(registry);

      if (next !== busy) {
        publish(next);
      }
    });

    host.onSessionStart(() => {
      publish(hasOpenAgents(registry));
    });

    return unsubscribe;
  },
};
