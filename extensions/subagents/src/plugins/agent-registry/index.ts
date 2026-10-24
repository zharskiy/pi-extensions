import { BUSY_CHANNEL } from "../../../../../shared/index.ts";
import { pastRecords } from "../../model/manifest.ts";
import { agentsDirFor, handoffPathFor } from "../../model/paths.ts";
import type { Plugin } from "../../model/plugin.ts";
import { type AgentRegistry, isClosed } from "../../model/types.ts";
import { createRegistry } from "./registry.ts";

const BUSY_SOURCE = "pi-subagents";

const hasOpenAgents = (registry: AgentRegistry) => registry.list().some((record) => !isClosed(record.state));

export const agentRegistryPlugin: Plugin = {
  id: "agent-registry",
  enable: ({ host, bus, services }) => {
    const registry = createRegistry({ bus, handoffPath: (id) => handoffPathFor(host.session(), id) });
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
      const session = host.session();

      registry.restore(
        pastRecords(host, agentsDirFor(session), (dir, manifest) => ({
          dir,
          handoffPath: handoffPathFor(session, manifest.id as string),
          contextLimit: 0,
        })),
      );
      publish(hasOpenAgents(registry));
    });

    return unsubscribe;
  },
};
