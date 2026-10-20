import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { costOf, waitUntil } from "../../../../core/test/adapter/live.ts";
import { type AgentRecord, chainLinks, chainTerminal, isClosed } from "../../src/model/types.ts";
import { PACKAGE_ROOT } from "./harness.ts";
import type { LiveHarness } from "./live.ts";

export const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

export const RUNS_ENV = "PI_LIVE_PLAN_RUNS";

export const liveRuns = () => Math.max(1, Math.floor(Number(process.env[RUNS_ENV] ?? "1")) || 1);

export const repoGit = (args: string[]) =>
  execFileSync("/usr/bin/git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

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
  durationMs: number;
  failure: string | undefined;
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

// Runs the lead on the task and waits until its chain (the lead and any
// successors after a handoff) has closed, then sums the chain's own tool calls
// and the cost of the whole tree under it. A chain still open after
// `timeoutMs` is reported as timed out with its figures so far.
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

  return {
    terminal: last,
    timedOut,
    links,
    helpers: helperRecords.map((record) => record.agent),
    helperRecords,
    calls: links.reduce((sum, link) => sum + link.toolCalls, 0),
    cost: costOf(tree.flatMap((id) => live.usage.get(id) ?? [])),
    durationMs,
    failure: failureReason(last),
  };
};

export const helperCounts = (helpers: string[]) => {
  const kinds = [...new Set(helpers)].sort();

  return kinds.length > 0
    ? ` (${kinds.map((kind) => `${kind} ${helpers.filter((helper) => helper === kind).length}`).join(", ")})`
    : "";
};

// One harness, and so one seeded project, per run; the runs of a fixture go
// concurrently. A failed run fails the test only after every run has settled,
// so no run outlives the test.
export const concurrentRuns = async <T>(runs: number, once: (index: number) => Promise<T>) => {
  const settled = await Promise.allSettled(Array.from({ length: runs }, (_, index) => once(index)));
  const failed = settled.find((result) => result.status === "rejected");

  if (failed) {
    throw failed.reason;
  }

  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
};

const TASK_MAX = 140;

const COMMAND_MAX = 80;

const COMMANDS_MAX = 8;

const TASK_HEADER = /^(Task from .* \(agent id .*\):|Agent folder: )/;

// The first line of the brief a helper got: the prompt the runner composed,
// without its `Task from` and `Agent folder` header lines.
export const taskLine = (prompt: string) =>
  (
    prompt
      .split("\n")
      .map((text) => text.trim())
      .find((text) => text !== "" && !TASK_HEADER.test(text)) ?? ""
  ).slice(0, TASK_MAX);

type SessionItem = { kind: string; text?: string; toolCalls?: { name: string; args: unknown }[] };

export const bashCommands = (items: SessionItem[]) =>
  items.flatMap((item) =>
    (item.kind === "assistant" ? (item.toolCalls ?? []) : []).flatMap((call) => {
      const command = (call.args as { command?: unknown } | undefined)?.command;

      return call.name === "bash" && typeof command === "string" ? [command] : [];
    }),
  );

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export const commandsLine = (commands: string[]) => {
  const shown = commands.slice(0, COMMANDS_MAX).map((command) => oneLine(command).slice(0, COMMAND_MAX));
  const more = commands.length > COMMANDS_MAX ? ", …" : "";

  return shown.length > 0 ? `    bash ${commands.length}: ${shown.join(" · ")}${more}` : "    bash 0";
};

export const helperLine = (agent: string, state: string, task: string, failure?: string) =>
  `    helper ${agent} ${state}: ${task}${failureSuffix(failure)}`;

const sessionItems = (live: LiveHarness, record: AgentRecord): SessionItem[] =>
  record.sessionFile && existsSync(record.sessionFile)
    ? live.runtime.readSession(record.sessionFile).items
    : [];

// What the lead handed over and ran itself: one line per helper in start
// order, then, with `commands`, the lead's own bash commands. Read before the
// harness closes, while the session files still exist.
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
