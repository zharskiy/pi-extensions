import {
  DOT,
  formatDuration,
  formatTokens,
  type HandoffLimit,
  workingContextText,
} from "../../../../platform/shared/index.ts";
import { cutChars, elapsedOf, formatCalls, singleLine } from "../components/receipt.ts";
import { type AgentRecord, WAITING, type Worktree, worktreeText } from "../model/agent-record.ts";
import { contextUse } from "../model/context-limit.ts";

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
  cost?: number;
  context: { tokens: number; limit: number } | null;
  lastLine: string;
  waiting?: string;
  resultPath?: string;
  handoffPath?: string;
  error?: string;
  graceSecondsLeft?: number;
  chainIndex: number;
  predecessorId?: string;
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

const waitingOf = (record: AgentRecord) => {
  const shown = record.state === "running" && record.activity?.startsWith(`${WAITING} `);

  return shown ? record.activity : undefined;
};

const contextOf = (record: AgentRecord, limit: HandoffLimit) => {
  const use = contextUse(record.context?.tokens, limit);

  return use ? { tokens: use.tokens, limit: use.request } : null;
};

const contextText = (context: AgentSnapshot["context"]) =>
  context ? workingContextText(context.tokens, context.limit) : "context n/a";

export const snapshotOf = (
  record: AgentRecord,
  now: number,
  options: { limit: HandoffLimit; requestedId?: string },
): AgentSnapshot => ({
  id: record.id,
  agent: record.agent,
  model: record.model,
  state: record.state,
  description: record.description,
  elapsedMs: elapsedOf(record, now),
  tokens: record.tokens,
  toolCalls: record.toolCalls,
  cost: record.cost,
  context: contextOf(record, options.limit),
  lastLine: lastLineOf(record.lastText),
  waiting: waitingOf(record),
  resultPath: record.resultPath,
  handoffPath: record.state === "handoff" ? record.handoffPath : undefined,
  error: record.error,
  graceSecondsLeft: graceSecondsLeft(record, now),
  chainIndex: record.chainIndex,
  predecessorId: record.predecessorId,
  requestedId: options.requestedId === record.id ? undefined : options.requestedId,
  worktree: record.worktree,
});

const chainText = (snapshot: AgentSnapshot) => {
  if (!snapshot.predecessorId) {
    return undefined;
  }

  return `chain: link ${snapshot.chainIndex}, continues ${snapshot.predecessorId}`;
};

export const snapshotLine = (snapshot: AgentSnapshot) => {
  const name = snapshot.requestedId ? `${snapshot.requestedId} → ${snapshot.id}` : snapshot.id;

  const parts = [
    `${name} (${snapshot.agent}, ${snapshot.model ?? "model n/a"}) ${stateLabel(snapshot)}`,
    formatDuration(snapshot.elapsedMs),
    formatCalls(snapshot.toolCalls),
    `${formatTokens(snapshot.tokens)} tokens`,
    contextText(snapshot.context),
  ];

  const extras = [
    chainText(snapshot),
    snapshot.waiting,
    snapshot.lastLine ? `last: ${snapshot.lastLine}` : undefined,
    snapshot.error ? `error: ${snapshot.error}` : undefined,
    snapshot.resultPath ? `result: ${snapshot.resultPath}` : undefined,
    snapshot.handoffPath ? `handoff: ${snapshot.handoffPath}` : undefined,
    snapshot.worktree ? `worktree: ${worktreeText(snapshot.worktree)}` : undefined,
  ].filter((part): part is string => part !== undefined);

  const lines = extras.map((extra) => `  ${extra}`);

  lines.unshift(parts.join(DOT));

  return lines.join("\n");
};

export type AgentStatusParams = { ids?: string[] };

export type AgentStatusDetails = { agents: AgentSnapshot[]; unknown: string[] };

export const unknownText = (id: string) => `${id}: unknown agent`;
