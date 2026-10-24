import { existsSync } from "node:fs";
import {
  type AgentRecord,
  chainLinks,
  chainTerminal,
  isClosed,
} from "../../../../extensions/subagents/tests/support/agent-records.ts";
import type { LiveHarness } from "../../../../extensions/subagents/tests/support/live-harness.ts";
import { type RunRecord, snapshotSessions } from "../../../framework/eval-runs/index.ts";
import { bashCommands, commandsLine, totalCost, waitUntil } from "../../../framework/index.ts";

const subtree = (records: AgentRecord[], rootId: string): AgentRecord[] => {
  const children = records.filter((record) => record.callerId === rootId);

  return children.flatMap((child) => [child, ...subtree(records, child.id)]);
};

export type ChainOutcome = {
  terminal: AgentRecord | undefined;
  timedOut: boolean;
  links: AgentRecord[];
  helpers: string[];
  helperRecords: AgentRecord[];
  calls: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  failure: string | undefined;
  sessionFiles: string[];
};

const REASON_MAX = 160;

export const failureReason = (record: Pick<AgentRecord, "error"> | undefined) => {
  const first = record?.error
    ?.split("\n")
    .find((text) => text.trim() !== "")
    ?.trim();

  return first ? first.slice(0, REASON_MAX) : undefined;
};

export const failureSuffix = (failure: string | undefined) => (failure ? ` (failed: ${failure})` : "");

export const runChain = async (
  live: LiveHarness,
  agent: string,
  task: string,
  timeoutMs: number,
): Promise<ChainOutcome> => {
  const startedAt = Date.now();
  const firstId = await live.run(agent, task);
  const terminal = () => {
    const first = live.registry.get(firstId);

    return first && chainTerminal(live.registry, first);
  };

  const timedOut = await waitUntil(
    () => {
      const last = terminal();

      return last !== undefined && isClosed(last.state) && last.state !== "handoff";
    },
    timeoutMs,
    `${agent} ${firstId} to close`,
  ).then(
    () => false,
    () => true,
  );

  const durationMs = Date.now() - startedAt;
  const records = live.registry.list();
  const last = terminal();
  const links = last ? chainLinks(live.registry, last) : [];
  const linkIds = links.map((link) => link.id);
  const tree = [...linkIds, ...linkIds.flatMap((id) => subtree(records, id).map((record) => record.id))];

  const helperRecords = records
    .filter((record) => linkIds.includes(record.callerId))
    .sort((left, right) => left.createdAt - right.createdAt);
  const usages = tree.flatMap((id) => live.usage.get(id) ?? []);

  return {
    terminal: last,
    timedOut,
    links,
    helpers: helperRecords.map((record) => record.agent),
    helperRecords,
    calls: links.reduce((sum, link) => sum + link.toolCalls, 0),
    cost: totalCost(usages),
    inputTokens: usages.reduce((sum, usage) => sum + usage.input, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.output, 0),
    durationMs,
    failure: failureReason(last),
    sessionFiles: records.flatMap((record) =>
      tree.includes(record.id) && record.sessionFile ? [record.sessionFile] : [],
    ),
  };
};

export const chainRecord = (label: string, chain: ChainOutcome): RunRecord => ({
  output: chain.terminal?.resultText ?? "",
  events: [],
  usage: {
    inputTokens: chain.inputTokens,
    outputTokens: chain.outputTokens,
    toolCalls: chain.calls,
    costUsd: chain.cost,
  },
  timings: { totalMs: chain.durationMs },
  errors: chain.failure ? [chain.failure] : [],
  snapshot: snapshotSessions(label, chain.sessionFiles),
});

export const helperCounts = (helpers: string[]) => {
  const kinds = [...new Set(helpers)].sort();

  return kinds.length > 0
    ? ` (${kinds.map((kind) => `${kind} ${helpers.filter((helper) => helper === kind).length}`).join(", ")})`
    : "";
};

const TASK_MAX = 140;

const TASK_HEADER = /^(Task from .* \(agent id .*\):|Agent folder: )/;

export const taskLine = (prompt: string) =>
  (
    prompt
      .split("\n")
      .map((text) => text.trim())
      .find((text) => text !== "" && !TASK_HEADER.test(text)) ?? ""
  ).slice(0, TASK_MAX);

export const helperLine = (agent: string, state: string, task: string, failure?: string) =>
  `    helper ${agent} ${state}: ${task}${failureSuffix(failure)}`;

const sessionItems = (live: LiveHarness, record: AgentRecord) =>
  record.sessionFile && existsSync(record.sessionFile)
    ? live.runtime.readSession(record.sessionFile).items
    : [];

export const handoverLines = (live: LiveHarness, chain: ChainOutcome, commands: boolean) => {
  const helpers = chain.helperRecords.map((record) => {
    const prompt = sessionItems(live, record).find((item) => item.kind === "user")?.text;

    return helperLine(
      record.agent,
      record.state,
      prompt ? taskLine(prompt) : record.description.slice(0, TASK_MAX),
      failureReason(record),
    );
  });

  return commands
    ? [...helpers, commandsLine(chain.links.flatMap((link) => bashCommands(sessionItems(live, link))))]
    : helpers;
};
