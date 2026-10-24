import type { ThemeLike, ToolRenderState, ToolResult } from "../../../../pi-adapter/index.ts";
import { DOT, noun } from "../../../../shared/index.ts";
import {
  countLine,
  expandHint,
  failureSuffix,
  type Mark,
  type MarkedRow,
  markOf,
  NEST,
  row,
  TITLE_COLUMN,
} from "../../../../ui-kit/index.ts";
import {
  agentReceipt,
  firstLine,
  plainReceipt,
  type ReceiptSegment,
  receipt,
  singleLine,
} from "../../core/components/receipt.ts";
import {
  type AgentRecord,
  type AgentRegistry,
  chainLinks,
  chainTerminal,
  isClosed,
  MAIN_CALLER,
  type WorktreeCleanup,
} from "../../core/model/agent-record.ts";
import { chainTotals } from "../../core/run-agent/result.ts";
import type { RunAgentDetails, RunAgentParams } from "../../core/run-agent/tools.ts";
import { chainSuffix, modelId } from "../components/agent-row.ts";
import { receiptText } from "../components/format.ts";
import { stateMark } from "../components/state-text.ts";

export type BlockHints = { manage(): boolean; list(): boolean; expandKey?(): string };

type BlockInput = {
  params: RunAgentParams | undefined;
  result?: ToolResult<RunAgentDetails>;
  state: ToolRenderState;
  registry: Pick<AgentRegistry, "get" | "batch">;
  theme: ThemeLike;
  hints: BlockHints;
};

const MODEL_MIN_BUDGET = 20;

const DESCRIPTION_MIN = 8;

const REASON_MAX = 40;

const REASON_ROWS = 2;

const AGENT_TEXT = NEST + TITLE_COLUMN;

const sharedAgent = (agents: { agent?: string }[]): string | undefined => {
  const first = agents[0]?.agent;

  if (!first || agents.some((entry) => entry.agent !== first)) {
    return undefined;
  }

  return first;
};

const nounPhrase = (agents: { agent?: string }[], background: boolean) => {
  const kind = sharedAgent(agents);
  const words = [background ? "background" : undefined, kind, noun(agents.length, "agent")];

  return words.filter((word) => word !== undefined).join(" ");
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

type Entry = RunAgentDetails["agents"][number];

const agentLine = (
  theme: ThemeLike,
  cols: number,
  parts: { name: string; chainIndex: number; description: string; model?: string },
) => {
  const suffix = chainSuffix(parts.chainIndex);
  const head = `${parts.name}${suffix}  `;
  const description = singleLine(parts.description);
  const tail = parts.model ? `${DOT}${modelId(parts.model)}` : "";
  const fits = theme.width(head) + theme.width(description) + theme.width(tail) <= cols;
  const keepModel = tail !== "" && (fits || cols - theme.width(head) - theme.width(tail) >= MODEL_MIN_BUDGET);
  const room = Math.max(DESCRIPTION_MIN, cols - theme.width(head) - (keepModel ? theme.width(tail) : 0));
  const name = `${theme.bold(theme.fg("text", parts.name))}${suffix ? theme.fg("muted", suffix) : ""}`;
  const model = keepModel ? theme.fg("dim", tail) : "";

  return `${name}  ${theme.fg("muted", theme.truncate(description, room))}${model}`;
};

const withCleanup = (
  segments: ReceiptSegment[],
  cleanup: string | undefined,
  cols: number,
  theme: ThemeLike,
) => {
  const suffix = cleanup ? `${DOT}${cleanup}` : "";
  const whole = theme.width(plainReceipt(segments)) + theme.width(suffix);

  if (!suffix || whole > cols) {
    return receiptText(segments, cols, theme);
  }

  return `${receiptText(segments, cols, theme)}${theme.fg("muted", suffix)}`;
};

const reasonLeads = (reason: string, totals: AgentRecord, cols: number, theme: ThemeLike) => {
  const time = agentReceipt(totals, 0, { live: false }).find((part) => part.kind === "time");
  const lead = `${reason}${time ? `${DOT}${time.text}` : ""}`;

  return !reason.includes("\n") && theme.width(reason) <= REASON_MAX && theme.width(lead) <= cols;
};

const failureLines = (
  terminal: AgentRecord,
  totals: AgentRecord,
  cols: number,
  input: BlockInput,
): string[] => {
  const { theme, state, hints } = input;
  const reason = (terminal.error ?? "unknown error").trim();
  const cleanup = cleanupText(terminal);

  if (reasonLeads(reason, totals, cols, theme)) {
    return [withCleanup(agentReceipt(totals, 0, { live: false, reason }), cleanup, cols, theme)];
  }

  const wrapped = reason.split("\n").flatMap((line) => theme.wrap(line, Math.max(1, cols)));
  const hidden = state.expanded ? 0 : Math.max(0, wrapped.length - REASON_ROWS);
  const shown = hidden > 0 ? wrapped.slice(0, REASON_ROWS) : wrapped;
  const count =
    hidden > 0
      ? [countLine({ hidden, end: "more", noun: "line", key: hints.expandKey?.() }, cols, theme)]
      : [];

  return [
    withCleanup(agentReceipt(totals, 0, { live: false }), cleanup, cols, theme),
    ...shown.map((line) => theme.fg("error", line)),
    ...count,
  ];
};

const statusLines = (
  terminal: AgentRecord,
  totals: AgentRecord,
  input: BlockInput,
  cols: number,
  wait: boolean,
) => {
  const { theme } = input;

  if (terminal.state === "failed") {
    return failureLines(terminal, totals, cols, input);
  }

  const segments = agentReceipt({ ...totals, activity: undefined }, Date.now(), { live: wait });

  return [withCleanup(segments, cleanupText(terminal), cols, theme)];
};

const unavailableRow = (entry: Entry, input: BlockInput, cols: number): MarkedRow => {
  const { theme, hints } = input;
  const status = hints.list() ? `Status unavailable${DOT}/agents ${entry.id}` : "Status unavailable";
  const line = agentLine(theme, cols, { name: entry.agent, chainIndex: 1, ...entry });

  return { mark: "info", title: `${line}\n${theme.fg("muted", theme.truncate(status, cols))}` };
};

const agentRow = (entry: Entry, input: BlockInput, cols: number, wait: boolean): MarkedRow => {
  const { registry, theme } = input;
  const record = registry.get(entry.id);

  if (!record) {
    return unavailableRow(entry, input, cols);
  }

  const terminal = chainTerminal(registry, record);
  const totals = chainTotals(chainLinks(registry, terminal));
  const line = agentLine(theme, cols, {
    name: terminal.agent,
    chainIndex: terminal.chainIndex,
    description: terminal.description,
    model: terminal.model ?? entry.model,
  });

  return {
    mark: stateMark(terminal.state),
    title: [line, ...statusLines(terminal, totals, input, cols, wait)].join("\n"),
  };
};

const terminalsOf = (input: BlockInput, ids: string[]) =>
  ids.flatMap((id) => {
    const record = input.registry.get(id);

    return record ? [chainTerminal(input.registry, record)] : [];
  });

const blockMark = (input: BlockInput, terminals: AgentRecord[]): Mark => {
  const { state, result } = input;

  if (state.isError || result?.isError) {
    return "error";
  }

  if (terminals.length === 0) {
    return (result?.details?.ids.length ?? 0) > 0 ? "pending" : markOf(state);
  }

  if (terminals.some((record) => !isClosed(record.state))) {
    return "pending";
  }

  if (terminals.some((record) => record.state === "failed")) {
    return "error";
  }

  return terminals.every((record) => record.state === "stopped" || record.state === "handoff")
    ? "stopped"
    : "success";
};

const hintText = (hints: BlockHints, short: boolean, theme: ThemeLike) => {
  const parts = [
    hints.manage() ? (["↓", "to manage"] as const) : undefined,
    !short && hints.list() ? (["←", "to list"] as const) : undefined,
  ].filter((part) => part !== undefined);

  if (parts.length === 0) {
    return undefined;
  }

  const inner = parts
    .map(([key, words]) => `${theme.fg("dim", key)} ${theme.fg("muted", words)}`)
    .join(theme.fg("muted", ", "));

  return `${theme.fg("muted", "(")}${inner}${theme.fg("muted", ")")}`;
};

const batchReceipt = (input: BlockInput, ids: string[]): ReceiptSegment[] => {
  const totals = terminalsOf(input, ids).map((terminal) => chainTotals(chainLinks(input.registry, terminal)));
  const starts = totals.map((record) => record.startedAt ?? record.createdAt);
  const ends = totals.map((record) => record.endedAt ?? record.createdAt);
  const sum = (pick: (record: AgentRecord) => number) =>
    totals.reduce((acc, record) => acc + pick(record), 0);

  if (totals.length === 0) {
    return [];
  }

  return receipt({
    running: false,
    elapsedMs: Math.max(...ends) - Math.min(...starts),
    calls: sum((record) => record.toolCalls),
    tokens: sum((record) => record.tokens),
    cost: sum((record) => record.cost),
  });
};

const countTitle = (theme: ThemeLike, count: number, words: string) =>
  `${theme.bold(theme.fg("text", String(count)))} ${theme.fg("text", words)}`;

const outcomeCounts = (terminals: AgentRecord[]) =>
  [
    ["stopped", terminals.filter((record) => record.state === "stopped").length],
    ["handed off", terminals.filter((record) => record.state === "handoff").length],
  ] as const;

const header = (input: BlockInput, details: RunAgentDetails, wait: boolean, width: number, mark: Mark) => {
  const { theme, registry, hints } = input;
  const count = details.agents.length;
  const words = nounPhrase(details.agents, !wait);
  const title = countTitle(theme, count, words);
  const room = width - TITLE_COLUMN - theme.width(`${count} ${words}`);
  const terminals = terminalsOf(input, details.ids);
  const records = details.batchId ? registry.batch(details.batchId) : [];
  const open = terminals.some((record) => !isClosed(record.state));

  if (open) {
    const hinted = !wait && records[0]?.callerId === MAIN_CALLER;
    const hint = hinted
      ? [hintText(hints, false, theme), hintText(hints, true, theme)].find(
          (text) => text !== undefined && theme.width(text) + 1 <= room,
        )
      : undefined;

    return hint ? `${title} ${hint}` : title;
  }

  const outcomes =
    mark === "success"
      ? outcomeCounts(terminals)
          .filter(([, n]) => n > 0)
          .map(([word, n]) => `${n} ${word}`)
      : [];
  const lead = outcomes.map((text) => `${DOT}${text}`).join("");
  const fitted = receiptText(
    batchReceipt(input, details.ids),
    Math.max(0, room - theme.width(lead) - DOT.length),
    theme,
  );

  return `${title}${theme.fg("muted", lead)}${fitted ? `${theme.fg("muted", DOT)}${fitted}` : ""}`;
};

const errorBlock = (input: BlockInput, result: ToolResult<RunAgentDetails>, width: number) => {
  const { theme, state, hints } = input;
  const lines = result.text.split("\n").filter((line) => line.trim() !== "");
  const reason = firstLine(result.text);
  const parts = { verb: (paint: ThemeLike) => paint.bold("No agents started") };
  const suffix =
    lines.length === 1 ? failureSuffix(reason, { ...parts, mark: "error" }, width, theme) : undefined;

  if (suffix) {
    return row({ mark: "error", title: { ...parts, reason: { text: suffix } } })(width, theme);
  }

  const shown = state.expanded ? lines : [reason];
  const more = !state.expanded && lines.length > 1 ? expandHint(hints.expandKey?.() ?? "") : undefined;

  return row({
    mark: "error",
    title: parts,
    children: shown.map((line) => theme.fg("error", line)),
    hint: more,
  })(width, theme);
};

const stoppedBlock = (input: BlockInput, params: RunAgentParams, width: number) => {
  const { theme } = input;
  const words = nounPhrase(params.agents, params.wait !== true);
  const title = `${countTitle(theme, params.agents.length, words)}${theme.fg("muted", `${DOT}stopped`)}`;

  return row({ mark: "stopped", title })(width, theme);
};

const renderBlockAt = (input: BlockInput, width: number): string => {
  const { result, state, theme, params } = input;

  if (!result) {
    return "";
  }

  const details = result.details;

  if (state.aborted && !details?.batchId && params?.agents?.length) {
    return stoppedBlock(input, params, width).join("\n");
  }

  if ((state.isError || result.isError) && !details?.batchId) {
    return errorBlock(input, result, width).join("\n");
  }

  if (!details?.agents) {
    return state.isPartial ? "" : result.text;
  }

  const wait = params?.wait === true;
  const cols = Math.max(1, width - AGENT_TEXT);
  const mark = blockMark(input, terminalsOf(input, details.ids));

  return row({
    mark,
    title: header(input, details, wait, width, mark),
    children: details.agents.map((entry) => agentRow(entry, input, cols, wait)),
  })(width, theme).join("\n");
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
