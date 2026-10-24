import type { AnyToolSpec, ToolSpec } from "../../../../platform/pi-adapter/index.ts";
import { EXPAND_BINDING } from "../../../../platform/ui-kit/index.ts";
import {
  type AgentStatusDetails,
  type AgentStatusParams,
  snapshotLine,
  snapshotOf,
  unknownText,
} from "../../core/agent-status/snapshot.ts";
import { type AgentRegistry, chainTerminal } from "../../core/model/agent-record.ts";
import type { Plugin } from "../../core/model/plugin.ts";
import { statusCall, statusResult } from "../../ui/agent-status/status-text.ts";

type StatusScope = {
  registry: AgentRegistry;
  callerId?: string;
  expandKey: () => string;
};

const MAIN_DESCRIPTION =
  "Report state, model, elapsed time, tokens, context use, last output line and result path for one or several agents in one call. Omit ids to list every agent of this session. Does not wake or disturb agents. You are woken when a batch you started is done; do not call this in a loop.";

const CHILD_DESCRIPTION =
  "Report state, model, elapsed time, tokens, context use, last output line and result path for one or several agents in one call. Omit ids to list the agents you started. Does not wake or disturb agents. You are woken when a batch you started is done; do not call this in a loop.";

const defaultIds = ({ registry, callerId }: StatusScope) =>
  registry
    .list()
    .filter((record) => (callerId === undefined || record.callerId === callerId) && !record.successorId)
    .map((record) => record.id);

const statusTool = (scope: StatusScope): ToolSpec<AgentStatusParams, AgentStatusDetails> => ({
  name: "agent_status",
  label: "Agent status",
  description: scope.callerId === undefined ? MAIN_DESCRIPTION : CHILD_DESCRIPTION,
  promptSnippet: "check one or several agents without disturbing them",
  parameters: {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" }, description: "Agent ids. Omit for all agents." },
    },
    additionalProperties: false,
  },
  execute: async (params) => {
    const now = Date.now();
    const wanted = params.ids && params.ids.length > 0 ? params.ids : defaultIds(scope);
    const unknownIds = wanted.filter((id) => !scope.registry.get(id));

    const agents = wanted
      .flatMap((id) => {
        const record = scope.registry.get(id);

        return record ? [snapshotOf(chainTerminal(scope.registry, record), now, id)] : [];
      })
      .filter((snapshot, index, all) => all.findIndex((other) => other.id === snapshot.id) === index);

    const lines = [...agents.map(snapshotLine), ...unknownIds.map(unknownText)];

    const text = lines.length > 0 ? lines.join("\n") : "No agents in this session.";
    return { text, details: { agents, unknown: unknownIds } };
  },
  renderShell: "row",
  renderCall: statusCall,
  renderResult: statusResult(scope.expandKey),
});

export const agentStatusPlugin: Plugin = {
  id: "agent-status",
  requires: ["agent-registry"],
  enable: ({ host, services }) => {
    const registry = services.require("registry");
    const expandKey = () => host.ui.keyText(EXPAND_BINDING);

    host.registerTool(statusTool({ registry, expandKey }));

    services.provide("agentStatus", {
      toolFor: (callerId): AnyToolSpec => statusTool({ registry, callerId, expandKey }),
    });
  },
};
