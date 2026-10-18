import type { AnyToolSpec, ToolSpec } from "../../../../../core/adapter/contract.ts";
import type { Plugin } from "../../model/plugin.ts";
import { type AgentRegistry, chainTerminal } from "../../model/types.ts";
import { type AgentSnapshot, snapshotLine, snapshotOf } from "./snapshot.ts";

export type AgentStatusParams = { ids?: string[] };

export type AgentStatusDetails = { agents: AgentSnapshot[]; unknown: string[] };

type StatusScope = {
  registry: AgentRegistry;
  callerId?: string;
};

const MAIN_DESCRIPTION =
  "Report state, model, elapsed time, tokens, context use, last output line and result path for one or several agents in one call. Omit ids to list every agent of this session. Does not wake or disturb agents.";

const CHILD_DESCRIPTION =
  "Report state, model, elapsed time, tokens, context use, last output line and result path for one or several agents in one call. Omit ids to list the agents you started. Does not wake or disturb agents.";

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
      .map((id) => ({ id, record: scope.registry.get(id) }))
      .flatMap(({ id, record }) =>
        record ? [snapshotOf(chainTerminal(scope.registry, record), now, id)] : [],
      )
      .filter((snapshot, index, all) => all.findIndex((other) => other.id === snapshot.id) === index);

    const lines = agents.map(snapshotLine);

    unknownIds.forEach((id) => {
      lines.push(`${id}: unknown agent`);
    });

    const text = lines.length > 0 ? lines.join("\n") : "No agents in this session.";
    return { text, details: { agents, unknown: unknownIds } };
  },
  renderCall: (params, theme) =>
    `${theme.bold("agent_status")} ${theme.fg("muted", params.ids?.join(", ") ?? "all")}`,
});

export const agentStatusPlugin: Plugin = {
  id: "agent-status",
  requires: ["agent-registry"],
  enable: ({ host, services }) => {
    const registry = services.require("registry");
    host.registerTool(statusTool({ registry }));

    services.provide("agentStatus", {
      toolFor: (callerId): AnyToolSpec => statusTool({ registry, callerId }),
    });
  },
};
