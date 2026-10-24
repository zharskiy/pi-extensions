import type { ThemeLike, ToolSpec } from "../../../../pi-adapter/index.ts";
import { noun } from "../../../../shared/index.ts";
import { expandHint, markOf, row, rowChildren, rowText } from "../../../../ui-kit/index.ts";
import {
  type AgentSnapshot,
  type AgentStatusDetails,
  type AgentStatusParams,
  unknownText,
} from "../../core/agent-status/snapshot.ts";
import { type RowInput, renderRows } from "../components/agent-row.ts";

type StatusTool = ToolSpec<AgentStatusParams, AgentStatusDetails>;

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

const expandedBody = (details: AgentStatusDetails | undefined) =>
  rowChildren({
    body: (width, theme) => [
      ...renderRows((details?.agents ?? []).map(rowOf), 0, width, theme, { spinner: false, bare: true }),
      ...(details?.unknown ?? []).map((id) => theme.fg("muted", unknownText(id))),
    ],
  });

export const statusCall: NonNullable<StatusTool["renderCall"]> = (params, theme, state) => {
  const ids = params.ids && params.ids.length > 0 ? params.ids.join(", ") : "all";
  const verb = (paint: ThemeLike) => paint.bold("agent_status");

  return rowText(row({ mark: markOf(state), title: { verb, target: { text: ids } } }), theme);
};

export const statusResult =
  (expandKey: () => string): NonNullable<StatusTool["renderResult"]> =>
  (result, state, theme) => {
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
    const hint = expandHint(expandKey());

    return rowText(rowChildren({ children: [summary], hint }), theme);
  };
