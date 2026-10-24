import type { AnyToolSpec, ThemeLike, ToolSpec } from "../../../../../core/adapter/contract.ts";
import { noun } from "../../../../../core/manager/format.ts";
import { EXPAND_BINDING, expandHint } from "../../../../../core/manager/hints.ts";
import { markOf } from "../../../../../core/manager/marks.ts";
import { row, rowChildren, rowText } from "../../../../../core/manager/row.ts";
import { type RowInput, renderRows } from "../../components/agent-row.ts";
import type { Plugin } from "../../model/plugin.ts";
import { type AgentRegistry, chainTerminal } from "../../model/types.ts";
import { type AgentSnapshot, snapshotLine, snapshotOf } from "./snapshot.ts";

export type AgentStatusParams = { ids?: string[] };

export type AgentStatusDetails = { agents: AgentSnapshot[]; unknown: string[] };

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

const rowOf = (snapshot: AgentSnapshot): RowInput => ({
  record: {
    agent: snapshot.agent,
    chainIndex: snapshot.chainIndex,
    description: snapshot.description,
    model: snapshot.model,
    state: snapshot.state,
    turns: 1,
    toolCalls: snapshot.toolCalls,
    tokens: snapshot.tokens,
    cost: snapshot.cost ?? 0,
    createdAt: 0,
    startedAt: 0,
    endedAt: snapshot.elapsedMs,
  },
  depth: 0,
  first: true,
  openDescendants: 0,
});

const unknownText = (id: string) => `${id}: unknown agent`;

const expandedBody = (details: AgentStatusDetails | undefined) =>
  rowChildren({
    body: (width, theme) => [
      ...renderRows((details?.agents ?? []).map(rowOf), 0, width, theme, { spinner: false, bare: true }),
      ...(details?.unknown ?? []).map((id) => theme.fg("muted", unknownText(id))),
    ],
  });

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
  renderCall: (params, theme, state) => {
    const ids = params.ids && params.ids.length > 0 ? params.ids.join(", ") : "all";
    const verb = (paint: ThemeLike) => paint.bold("agent_status");

    return rowText(row({ mark: markOf(state), title: { verb, target: { text: ids } } }), theme);
  },
  renderResult: (result, state, theme) => {
    const lines = result.text.split("\n");

    if (result.isError) {
      return rowText(rowChildren({ children: lines.map((line) => theme.fg("error", line)) }), theme);
    }

    const listed = (result.details?.agents.length ?? 0) + (result.details?.unknown.length ?? 0);

    if (state.expanded && listed > 0) {
      return rowText(expandedBody(result.details), theme);
    }

    if (state.expanded) {
      return rowText(rowChildren({ children: lines.map((line) => theme.fg("muted", line)) }), theme);
    }

    const count = result.details?.agents.length ?? 0;
    const summary = `${theme.fg("text", String(count))} ${theme.fg("muted", noun(count, "agent"))}`;
    const hint = expandHint(scope.expandKey());

    return rowText(rowChildren({ children: [summary], hint }), theme);
  },
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
