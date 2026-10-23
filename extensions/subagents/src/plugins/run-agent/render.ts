import type { ThemeLike, ToolRenderState, ToolResult } from "../../../../../core/adapter/contract.ts";
import {
  CHILD_INDENT,
  type RowState,
  TITLE_INDENT,
  toolRow,
  toolState,
} from "../../../../../core/manager/row.ts";
import { agentName } from "../../components/agent-row.ts";
import {
  elapsedOf,
  firstLine,
  formatDuration,
  formatTokens,
  formatToolUses,
  SEP,
  singleLine,
  wrapCols,
} from "../../components/format.ts";
import { stateToken } from "../../components/state-text.ts";
import {
  type AgentRecord,
  type AgentRegistry,
  chainLinks,
  chainTerminal,
  isClosed,
  MAIN_CALLER,
  type WorktreeCleanup,
} from "../../model/types.ts";
import { chainTotals } from "./result.ts";
import type { BatchItem } from "./runner.ts";

export type RunAgentParams = { agents: BatchItem[]; wait?: boolean };

export type RunAgentDetails = {
  batchId?: string;
  ids: string[];
  agents: { id: string; agent: string; description: string; model?: string }[];
};

export type BlockHints = { manage(): boolean; list(): boolean };

type BlockInput = {
  params: RunAgentParams | undefined;
  result?: ToolResult<RunAgentDetails>;
  state: ToolRenderState;
  registry: Pick<AgentRegistry, "get" | "batch">;
  theme: ThemeLike;
  hints: BlockHints;
};

export const BLOCK_WIDTH = 100;

const blockWidth = (width: number) => Math.max(1, Math.min(width, BLOCK_WIDTH));

const CONTINUATION = 3;

const MODEL_MIN_BUDGET = 20;

const DESCRIPTION_MIN = 8;

const agentsWord = (n: number) => (n === 1 ? "agent" : "agents");

const sharedAgent = (agents: { agent?: string }[]): string | undefined => {
  const first = agents[0]?.agent;

  if (!first || agents.some((entry) => entry.agent !== first)) {
    return undefined;
  }

  return first;
};

const namedAgents = (agents: { agent?: string }[], n: number) => {
  const kind = sharedAgent(agents);

  return kind ? `${kind} ${agentsWord(n)}` : agentsWord(n);
};

const CLEANUP_TEXT: Record<WorktreeCleanup, (branch: string) => string> = {
  removed: () => "worktree removed",
  "branch kept": (branch) => `branch ${branch} kept`,
  kept: () => "worktree kept",
};

const cleanupText = (record: AgentRecord) => {
  const cleanup = record.worktree?.cleanup;

  return isClosed(record.state) && cleanup && record.worktree
    ? CLEANUP_TEXT[cleanup](record.worktree.branch)
    : undefined;
};

const statsOf = (totals: AgentRecord, withDuration: boolean) =>
  [
    formatToolUses(totals.toolCalls),
    totals.tokens > 0 ? `${formatTokens(totals.tokens)} tokens` : undefined,
    withDuration ? formatDuration(elapsedOf(totals, totals.endedAt ?? totals.createdAt)) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(SEP);

type Status = { lead: string; leadToken: Parameters<ThemeLike["fg"]>[0]; rest?: string };

const statusOf = (terminal: AgentRecord, totals: AgentRecord, wait: boolean): Status => {
  const token = stateToken(terminal.state);

  if (terminal.state === "queued") {
    return { lead: "Queued", leadToken: "muted" };
  }

  if (terminal.state === "running") {
    if (terminal.turns === 0 && terminal.toolCalls === 0 && !terminal.activity) {
      return { lead: "Initializing…", leadToken: "muted" };
    }

    return wait
      ? { lead: ["Running", statsOf(totals, false)].join(SEP), leadToken: "muted" }
      : { lead: "Running in the background", leadToken: "muted" };
  }

  if (terminal.state === "grace") {
    return { lead: "Stopping…", leadToken: "muted" };
  }

  if (terminal.state === "done") {
    return { lead: "Done", leadToken: token, rest: `${SEP}${statsOf(totals, true)}` };
  }

  if (terminal.state === "failed") {
    return { lead: `Failed: ${firstLine(terminal.error ?? "unknown error")}`, leadToken: token };
  }

  if (terminal.state === "stopped") {
    return { lead: `Stopped${SEP}${statsOf(totals, true)}`, leadToken: token };
  }

  return { lead: `Handed off${SEP}${statsOf(totals, true)}`, leadToken: token };
};

const statusLine = (
  terminal: AgentRecord,
  totals: AgentRecord,
  wait: boolean,
  theme: ThemeLike,
  width: number,
) => {
  const status = statusOf(terminal, totals, wait);
  const cleanup = cleanupText(terminal);
  const suffix = cleanup ? `${SEP}${cleanup}` : "";
  const budget = width - CONTINUATION - theme.width(suffix);
  const lead = theme.truncate(status.lead, budget);
  const rest = status.rest ? theme.truncate(status.rest, Math.max(0, budget - theme.width(lead))) : "";
  const painted = `${theme.fg(status.leadToken, lead)}${rest ? theme.fg("dim", rest) : ""}`;

  return suffix ? `${painted}${theme.fg("dim", suffix)}` : painted;
};

const nameLine = (
  connector: string,
  name: string,
  description: string,
  model: string | undefined,
  theme: ThemeLike,
  width: number,
) => {
  const head = `${connector}${name} (`;
  const fullTail = model ? `)${SEP}${model}` : ")";
  const budgetWith = width - theme.width(head) - theme.width(fullTail);
  const keepModel = model !== undefined && budgetWith >= MODEL_MIN_BUDGET;
  const tail = keepModel ? fullTail : ")";
  const budget = Math.max(DESCRIPTION_MIN, width - theme.width(head) - theme.width(tail));
  const cut = theme.truncate(singleLine(description), budget);
  const modelPart = keepModel ? theme.fg("dim", `${SEP}${model}`) : "";

  return `${connector}${theme.bold(name)} ${theme.fg("muted", `(${cut})`)}${modelPart}`;
};

const agentRows = (input: BlockInput, details: RunAgentDetails, wait: boolean, width: number) => {
  const { registry, theme, hints } = input;

  return details.agents.flatMap((entry, index) => {
    const last = index === details.agents.length - 1;
    const connector = last ? "└─ " : "├─ ";
    const continuation = last ? "   " : "│  ";
    const record = registry.get(entry.id);

    if (!record) {
      return [
        nameLine(connector, entry.agent, entry.description, entry.model, theme, width),
        `${continuation}${theme.fg("dim", hints.list() ? `Status unavailable${SEP}/agents ${entry.id}` : "Status unavailable")}`,
      ];
    }

    const terminal = chainTerminal(registry, record);
    const totals = chainTotals(chainLinks(registry, terminal));
    return [
      nameLine(
        connector,
        agentName(terminal),
        terminal.description,
        terminal.model ?? entry.model,
        theme,
        width,
      ),
      `${continuation}${statusLine(terminal, totals, wait, theme, width)}`,
    ];
  });
};

const errorBlock = (
  result: ToolResult<RunAgentDetails>,
  expanded: boolean,
  theme: ThemeLike,
  width: number,
) => {
  const cols = Math.max(1, width - CHILD_INDENT.length);
  const reason = expanded
    ? result.text.split("\n").flatMap((line) => wrapCols(theme, line, cols))
    : [firstLine(result.text)];

  return toolRow({ state: "error", title: "No agents started", children: reason })(width, theme).join("\n");
};

const hintText = (hints: BlockHints, short: boolean) => {
  const parts = [hints.manage() && "↓ to manage", !short && hints.list() && "← to list"].filter(
    (part): part is string => typeof part === "string",
  );

  return parts.length > 0 ? `(${parts.join(SEP)})` : "";
};

const header = (input: BlockInput, details: RunAgentDetails, wait: boolean, width: number) => {
  const { theme, registry, hints, state } = input;
  const n = details.agents.length;
  const named = namedAgents(details.agents, n);
  const count = theme.bold(String(n));

  if (wait) {
    return `${count} ${named} ${state.isPartial ? "launched" : "finished"}`;
  }

  const text = `${count} background ${named} launched`;
  const records = details.batchId ? registry.batch(details.batchId) : [];
  const hinted = records[0]?.callerId === MAIN_CALLER && records.some((record) => !isClosed(record.state));
  const full = hinted ? hintText(hints, false) : "";

  if (!full) {
    return text;
  }

  const fits = theme.width(`${n} background ${named} launched ${full}`) <= width;
  const hint = fits ? full : hintText(hints, true);

  return hint ? `${text} ${theme.fg("dim", hint)}` : text;
};

const renderBlockAt = (input: BlockInput, renderWidth: number): string => {
  const { result, state, theme } = input;
  const width = blockWidth(renderWidth);

  if (!result) {
    return "";
  }

  const details = result.details;

  if ((state.isError || result.isError) && !details?.batchId) {
    return errorBlock(result, state.expanded, theme, width);
  }

  if (!details?.agents) {
    return state.isPartial ? "" : result.text;
  }

  const wait = input.params?.wait === true;
  const inner = Math.max(1, width - TITLE_INDENT.length);
  const title = toolRow({
    state: blockState(input.registry, input.state, result),
    title: header(input, details, wait, inner),
  })(width, theme);
  const rows = agentRows(input, details, wait, inner).map((line) => `${TITLE_INDENT}${line}`);

  return [...title, ...rows].join("\n");
};

export const renderBlock = (input: BlockInput) => {
  let last: { width: number; text: string } | undefined;

  return (width: number): string => {
    if (last?.width !== width) {
      last = { width, text: renderBlockAt(input, width) };
    }

    return last.text;
  };
};

const blockState = (
  registry: Pick<AgentRegistry, "get">,
  state: ToolRenderState,
  result: ToolResult<RunAgentDetails> | undefined,
): RowState => {
  if (state.isError || result?.isError) {
    return "error";
  }

  const terminals = (result?.details?.ids ?? []).flatMap((id) => {
    const record = registry.get(id);

    return record ? [chainTerminal(registry, record)] : [];
  });

  if (terminals.length === 0) {
    return toolState(state);
  }

  if (terminals.some((record) => !isClosed(record.state))) {
    return "pending";
  }

  return terminals.some((record) => record.state === "failed") ? "error" : "success";
};
