import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { elapsedOf, formatDuration, formatTokens, singleLine } from "../../components/format.ts";
import { type AgentRecord, chainLinks, worktreeText } from "../../model/types.ts";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const statsText = (record: AgentRecord, now: number) =>
  [
    plural(record.toolCalls, "tool call"),
    `${formatTokens(record.tokens)} tokens`,
    formatDuration(elapsedOf(record, now)),
  ].join(" · ");

const finishSummary = (record: AgentRecord, now: number) => {
  const stats = statsText(record, now);

  if (record.state === "done") {
    return `Done (${stats})`;
  }

  if (record.state === "handoff") {
    return `Handoff (${stats})`;
  }

  if (record.state === "stopped") {
    return `Stopped (${stats})`;
  }

  return `Failed: ${record.error ?? "unknown error"} (${stats})`;
};

const cutChars = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;

type StoredResult = { resultText: string; resultPath?: string; error?: string };

export const storeResult = (record: AgentRecord, text: string): StoredResult => {
  const resultPath = join(record.dir, "result.md");

  try {
    mkdirSync(record.dir, { recursive: true });
    writeFileSync(resultPath, text.endsWith("\n") ? text : `${text}\n`);

    return { resultText: text, resultPath };
  } catch (error) {
    return { resultText: text, error: `result file not written: ${(error as Error).message}` };
  }
};

export const chainTotals = (links: AgentRecord[]): AgentRecord => {
  const first = links[0];
  const last = links[links.length - 1];

  return {
    ...last,
    createdAt: first.createdAt,
    startedAt: first.startedAt ?? first.createdAt,
    toolCalls: links.reduce((sum, link) => sum + link.toolCalls, 0),
    tokens: links.reduce((sum, link) => sum + link.tokens, 0),
  };
};

const chainLine = (links: AgentRecord[]) =>
  `Chain: ${links.map((link) => link.id).join(" → ")} (${links.length} sessions)`;

const resultEntry = (record: AgentRecord, inlineLimit: number, now: number, links: AgentRecord[]) => {
  const chained = links.length > 1;
  const lines = [
    `## ${record.id} (${record.agent}) - ${record.state}`,
    `Task: ${cutChars(singleLine(record.description), 200)}`,
  ];

  if (chained) {
    lines.push(chainLine(links));
  }

  lines.push(finishSummary(chained ? chainTotals(links) : record, now));

  if (record.worktree) {
    lines.push(`Worktree: ${worktreeText(record.worktree)}`);
  }

  if (record.state === "handoff") {
    lines.push(`Handoff file: ${record.handoffPath}${record.error ? ` (invalid: ${record.error})` : ""}`);

    return lines.join("\n");
  }

  const carriesResult = record.state === "done" || (record.state === "stopped" && Boolean(record.resultText));

  if (!carriesResult) {
    return lines.join("\n");
  }

  const text = record.resultText ?? "";

  if (!record.resultPath || text.length <= inlineLimit) {
    lines.push("", text);

    return lines.join("\n");
  }

  lines.push(
    `Result file: ${record.resultPath} (${text.length} chars)`,
    `Preview: ${cutChars(singleLine(text), 300)}`,
  );

  return lines.join("\n");
};

const countByState = (records: AgentRecord[]) => {
  const counts = records.reduce<Record<string, number>>((tally, record) => {
    tally[record.state] = (tally[record.state] ?? 0) + 1;
    return tally;
  }, {});

  return Object.entries(counts)
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
};

export const batchMessage = (batchId: string, records: AgentRecord[], inlineLimit: number, now: number) => {
  const byId = new Map(records.map((record) => [record.id, record]));
  const lookup = { get: (id: string) => byId.get(id) };
  const terminals = records.filter((record) => !(record.successorId && byId.has(record.successorId)));
  const header = `[pi-subagents] Batch ${batchId} finished: ${countByState(terminals)}.`;

  const entries = terminals.map((record) =>
    resultEntry(record, inlineLimit, now, chainLinks(lookup, record)),
  );

  entries.unshift(header);

  return entries.join("\n\n");
};
