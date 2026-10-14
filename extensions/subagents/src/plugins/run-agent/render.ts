import type {
  ThemeLike,
  ToolRenderState,
  ToolResult,
  ToolTone,
} from "../../../../../core/adapter/contract.ts";
import {
  charWidth,
  displayWidth,
  elapsedOf,
  firstLine,
  formatDuration,
  formatTokens,
  formatToolUses,
  SEP,
  singleLine,
  truncateCols,
} from "../../components/format.ts";
import {
  type AgentRecord,
  type AgentRegistry,
  chainLinks,
  chainTerminal,
  isClosed,
  type WorktreeCleanup,
} from "../../model/types.ts";
import { chainTotals } from "./result.ts";
import type { RunAgentParams } from "./tools.ts";

export type RunAgentDetails = {
  batchId?: string;
  ids: string[];
  agents: { id: string; agent: string; description: string; model?: string }[];
};

export type BlockInput = {
  params: RunAgentParams | undefined;
  result?: ToolResult<RunAgentDetails>;
  state: ToolRenderState;
  registry: Pick<AgentRegistry, "get" | "batch">;
  theme: ThemeLike;
  now: number;
};

/** The widest the block draws; a narrower render width shrinks every budget. */
export const BLOCK_WIDTH = 100;

/** The render width a block uses: the width pi gives (minus `outputPad` on both sides), at most `BLOCK_WIDTH`. */
export const blockWidth = (width: number) => Math.max(1, Math.min(width, BLOCK_WIDTH));

const CONTINUATION = 3;

const MODEL_MIN_BUDGET = 20;

const DESCRIPTION_MIN = 8;

const agentsWord = (n: number) => (n === 1 ? "agent" : "agents");

export const sharedAgent = (agents: { agent?: string }[]): string | undefined => {
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

const statsOf = (totals: AgentRecord, now: number, withDuration: boolean) =>
  [
    formatToolUses(totals.toolCalls),
    totals.tokens > 0 ? `${formatTokens(totals.tokens)} tokens` : undefined,
    withDuration ? formatDuration(elapsedOf(totals, now)) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(SEP);

type Status = { lead: string; leadToken: Parameters<ThemeLike["fg"]>[0]; rest?: string; restToken?: "dim" };

const statusOf = (terminal: AgentRecord, totals: AgentRecord, wait: boolean, now: number): Status => {
  const stats = statsOf(totals, now, true);

  if (terminal.state === "queued") {
    return { lead: "Queued", leadToken: "muted" };
  }

  if (terminal.state === "running") {
    if (terminal.turns === 0 && terminal.toolCalls === 0 && !terminal.activity) {
      return { lead: "Initializing…", leadToken: "muted" };
    }

    return wait
      ? { lead: ["Running", statsOf(totals, now, false)].join(SEP), leadToken: "muted" }
      : { lead: "Running in the background", leadToken: "muted" };
  }

  if (terminal.state === "grace") {
    return { lead: "Stopping…", leadToken: "warning" };
  }

  if (terminal.state === "done") {
    return { lead: "Done", leadToken: "success", rest: `${SEP}${stats}`, restToken: "dim" };
  }

  if (terminal.state === "failed") {
    return { lead: `Failed: ${firstLine(terminal.error ?? "unknown error")}`, leadToken: "error" };
  }

  if (terminal.state === "stopped") {
    return { lead: `Stopped${SEP}${stats}`, leadToken: "muted" };
  }

  return { lead: `Handed off${SEP}${stats}`, leadToken: "warning" };
};

const statusLine = (
  terminal: AgentRecord,
  totals: AgentRecord,
  wait: boolean,
  theme: ThemeLike,
  now: number,
  width: number,
) => {
  const status = statusOf(terminal, totals, wait, now);
  const cleanup = cleanupText(terminal);
  const suffix = cleanup ? `${SEP}${cleanup}` : "";
  const budget = width - CONTINUATION - displayWidth(suffix);
  const lead = truncateCols(status.lead, budget);
  const rest = status.rest ? truncateCols(status.rest, Math.max(0, budget - displayWidth(lead))) : "";
  const painted = `${theme.fg(status.leadToken, lead)}${rest ? theme.fg(status.restToken ?? "dim", rest) : ""}`;

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
  const budgetWith = width - displayWidth(head) - displayWidth(fullTail);
  const keepModel = model !== undefined && budgetWith >= MODEL_MIN_BUDGET;
  const tail = keepModel ? fullTail : ")";
  const budget = Math.max(DESCRIPTION_MIN, width - displayWidth(head) - displayWidth(tail));
  const cut = truncateCols(singleLine(description), budget);
  const modelPart = keepModel ? theme.fg("dim", `${SEP}${model}`) : "";

  return `${connector}${theme.bold(name)} ${theme.fg("muted", `(${cut})`)}${modelPart}`;
};

const agentRows = (input: BlockInput, details: RunAgentDetails, wait: boolean, width: number) => {
  const { registry, theme, now } = input;

  return details.agents.flatMap((entry, index) => {
    const last = index === details.agents.length - 1;
    const connector = last ? "└─ " : "├─ ";
    const continuation = last ? "   " : "│  ";
    const record = registry.get(entry.id);

    if (!record) {
      return [
        nameLine(connector, entry.agent, entry.description, entry.model, theme, width),
        `${continuation}${theme.fg("dim", `Status unavailable${SEP}/agents ${entry.id}`)}`,
      ];
    }

    const terminal = chainTerminal(registry, record);
    const totals = chainTotals(chainLinks(registry, terminal));
    const name = `${terminal.agent}${terminal.chainIndex > 1 ? ` #${terminal.chainIndex}` : ""}`;

    return [
      nameLine(connector, name, terminal.description, terminal.model ?? entry.model, theme, width),
      `${continuation}${statusLine(terminal, totals, wait, theme, now, width)}`,
    ];
  });
};

const ERROR_INDENT = "   ";

/** Cuts `line` into pieces of at most `cols` columns (never fewer than one character per piece). */
const wrapCols = (line: string, cols: number): string[] =>
  Array.from(line).reduce<{ lines: string[]; used: number }>(
    (acc, char) => {
      const width = charWidth(char);

      if (acc.used + width > cols && acc.used > 0) {
        acc.lines.push(char);

        return { lines: acc.lines, used: width };
      }

      acc.lines[acc.lines.length - 1] += char;

      return { lines: acc.lines, used: acc.used + width };
    },
    { lines: [""], used: 0 },
  ).lines;

const errorBlock = (
  result: ToolResult<RunAgentDetails>,
  expanded: boolean,
  theme: ThemeLike,
  width: number,
) => {
  const header = theme.fg("error", `✗ No agents started: ${firstLine(result.text)}`);

  if (!expanded) {
    return header;
  }

  const cols = Math.max(1, width - ERROR_INDENT.length);
  const body = result.text
    .split("\n")
    .flatMap((line) => wrapCols(line, cols).map((piece) => `${ERROR_INDENT}${piece}`));

  return [header, ...body].join("\n");
};

const MANAGE_HINT = `(↓ to manage${SEP}← to list)`;
const MANAGE_HINT_SHORT = "(↓ to manage)";

const finalHeader = (input: BlockInput, details: RunAgentDetails, wait: boolean, width: number) => {
  const { theme, registry } = input;
  const n = details.agents.length;
  const named = namedAgents(details.agents, n);
  const count = theme.bold(String(n));

  if (wait) {
    return `${count} ${named} finished`;
  }

  const open =
    details.batchId !== undefined &&
    registry.batch(details.batchId).some((record) => !isClosed(record.state));

  const text = `${count} background ${named} launched`;

  if (!open) {
    return text;
  }

  const fits = displayWidth(`${n} background ${named} launched ${MANAGE_HINT}`) <= width;

  return `${text} ${theme.fg("dim", fits ? MANAGE_HINT : MANAGE_HINT_SHORT)}`;
};

const partialHeader = (input: BlockInput, details: RunAgentDetails, wait: boolean, width: number) =>
  wait
    ? `${input.theme.bold(String(details.agents.length))} ${namedAgents(details.agents, details.agents.length)} launched`
    : finalHeader(input, details, false, width);

/** Header and rows (the error header for a failed launch) at `width`, the render width pi gives the block (bounded by `BLOCK_WIDTH`). */
export const renderBlockAt = (input: BlockInput, renderWidth: number): string => {
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
  const rows = agentRows(input, details, wait, width);

  if (state.isPartial) {
    return [partialHeader(input, details, wait, width), ...rows].join("\n");
  }

  return [finalHeader(input, details, wait, width), ...rows].join("\n");
};

/** The block as a function of the render width, for `ToolSpec.renderResult` (the adapter calls it on every render). */
export const renderBlock =
  (input: BlockInput) =>
  (width: number): string =>
    renderBlockAt(input, width);

/**
 * The block's box colour: error when the tool errored; pending while any agent of the batch is open (also after a
 * background launch returned); then error if any agent failed, else success. Undefined (pi's rule) when the
 * registry has no record of the batch, e.g. after `/reload`.
 */
export const blockTone = (
  registry: Pick<AgentRegistry, "get">,
  state: ToolRenderState,
  result: ToolResult<RunAgentDetails> | undefined,
): ToolTone | undefined => {
  if (state.isError || result?.isError) {
    return "error";
  }

  const terminals = (result?.details?.ids ?? []).flatMap((id) => {
    const record = registry.get(id);

    return record ? [chainTerminal(registry, record)] : [];
  });

  if (terminals.length === 0) {
    return undefined;
  }

  if (terminals.some((record) => !isClosed(record.state))) {
    return "pending";
  }

  return terminals.some((record) => record.state === "failed") ? "error" : "success";
};
