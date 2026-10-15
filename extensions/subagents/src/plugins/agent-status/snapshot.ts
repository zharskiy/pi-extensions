import {
  cutChars,
  elapsedOf,
  formatDuration,
  formatTokens,
  formatToolUses,
  singleLine,
} from "../../components/format.ts";
import { type AgentRecord, type Worktree, worktreeText } from "../../model/types.ts";

const graceSecondsLeft = (record: AgentRecord, now: number) => {
  if (record.state !== "grace" || record.graceEndsAt === undefined) {
    return undefined;
  }

  return Math.max(0, Math.ceil((record.graceEndsAt - now) / 1_000));
};

export type AgentSnapshot = {
  id: string;
  agent: string;
  model?: string;
  state: AgentRecord["state"];
  description: string;
  elapsedMs: number;
  tokens: number;
  toolCalls: number;
  contextPercent: number | null;
  lastLine: string;
  resultPath?: string;
  handoffPath?: string;
  error?: string;
  graceSecondsLeft?: number;
  chainIndex: number;
  predecessorId?: string;
  successorId?: string;
  requestedId?: string;
  worktree?: Worktree;
};

const lastLineOf = (text: string) => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return cutChars(singleLine(lines.at(-1) ?? ""), 160);
};

const stateLabel = (snapshot: AgentSnapshot) => {
  if (snapshot.state !== "grace") {
    return snapshot.state;
  }

  if (snapshot.graceSecondsLeft === undefined) {
    return "grace (answering a message)";
  }

  return `grace (closes in ${snapshot.graceSecondsLeft}s unless messaged)`;
};

export const snapshotOf = (record: AgentRecord, now: number, requestedId?: string): AgentSnapshot => ({
  id: record.id,
  agent: record.agent,
  model: record.model,
  state: record.state,
  description: record.description,
  elapsedMs: elapsedOf(record, now),
  tokens: record.tokens,
  toolCalls: record.toolCalls,
  contextPercent: record.context?.percent ?? null,
  lastLine: lastLineOf(record.lastText),
  resultPath: record.resultPath,
  handoffPath: record.state === "handoff" ? record.handoffPath : undefined,
  error: record.error,
  graceSecondsLeft: graceSecondsLeft(record, now),
  chainIndex: record.chainIndex,
  predecessorId: record.predecessorId,
  successorId: record.successorId,
  requestedId: requestedId === record.id ? undefined : requestedId,
  worktree: record.worktree,
});

const chainText = (snapshot: AgentSnapshot) => {
  if (!snapshot.predecessorId) {
    return undefined;
  }

  return `chain: link ${snapshot.chainIndex}, continues ${snapshot.predecessorId}`;
};

export const snapshotLine = (snapshot: AgentSnapshot) => {
  const percent =
    snapshot.contextPercent === null ? "ctx n/a" : `ctx ${Math.round(snapshot.contextPercent)}%`;

  const name = snapshot.requestedId ? `${snapshot.requestedId} → ${snapshot.id}` : snapshot.id;

  const parts = [
    `${name} (${snapshot.agent}, ${snapshot.model ?? "model n/a"}) ${stateLabel(snapshot)}`,
    formatDuration(snapshot.elapsedMs),
    `${formatTokens(snapshot.tokens)} tokens`,
    formatToolUses(snapshot.toolCalls),
    percent,
  ];

  const extras = [
    chainText(snapshot),
    snapshot.lastLine ? `last: ${snapshot.lastLine}` : undefined,
    snapshot.error ? `error: ${snapshot.error}` : undefined,
    snapshot.resultPath ? `result: ${snapshot.resultPath}` : undefined,
    snapshot.handoffPath ? `handoff: ${snapshot.handoffPath}` : undefined,
    snapshot.worktree ? `worktree: ${worktreeText(snapshot.worktree)}` : undefined,
  ].filter((part): part is string => part !== undefined);

  const lines = extras.map((extra) => `  ${extra}`);

  lines.unshift(parts.join(" · "));

  return lines.join("\n");
};
