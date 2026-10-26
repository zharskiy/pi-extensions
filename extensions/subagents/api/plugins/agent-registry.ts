import type { SessionInfo } from "../../../../platform/pi-adapter/index.ts";
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

    host.onSessionStart((info) => {
      const pastIn = (owner: SessionInfo) =>
        pastRecords(host, agentsDirFor(owner), (dir, manifest) => ({
          dir,
          handoffPath: handoffPathFor(info, manifest.id as string),
          contextLimit: 0,
        }));

      registry.restore(pastIn(info));

      if (info.parentSession) {
        registry.restore(pastIn({ ...info, file: info.parentSession }));
      }

      publish(hasOpenAgents(registry));
    });

    return unsubscribe;
  },
};
