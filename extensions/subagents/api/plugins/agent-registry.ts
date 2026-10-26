import { BUSY_CHANNEL } from "../../../../platform/shared/index.ts";
import { createRegistry } from "../../core/agent-registry/registry.ts";
import { type AgentRegistry, isClosed } from "../../core/model/agent-record.ts";
import { pastRecords } from "../../core/model/manifest.ts";
import { agentsDirFor, handoffPathFor } from "../../core/model/paths.ts";
import type { Plugin } from "../../core/model/plugin.ts";

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

    host.onSessionStart((_info, parent) => {
      const session = host.session();

      const pastIn = (owner: typeof session) =>
        pastRecords(host, agentsDirFor(owner), (dir, manifest) => ({
          dir,
          handoffPath: handoffPathFor(session, manifest.id as string),
          contextLimit: 0,
        }));

      registry.restore(pastIn(session));

      if (parent) {
        registry.restore(pastIn({ ...session, file: parent }));
      }

      publish(hasOpenAgents(registry));
    });

    return unsubscribe;
  },
};
