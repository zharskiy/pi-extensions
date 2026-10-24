import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plainReceipt, receipt } from "../../../../../core/manager/format.ts";
import { cutChars, elapsedOf, errorText, singleLine } from "../../components/format.ts";
import { isTerminal } from "../../components/tree.ts";
import { type AgentRecord, chainLinks, worktreeText } from "../../model/types.ts";

const SUMMARY_WORDS: Partial<Record<AgentRecord["state"], string>> = {
  done: "Done",
  handoff: "Handed off",
  stopped: "Stopped",
};

const finishSummary = (record: AgentRecord) => {
  const word = SUMMARY_WORDS[record.state];

  return plainReceipt(
    receipt({
      word: word ?? "Failed",
      reason: word ? undefined : (record.error ?? "unknown error"),
      elapsedMs: elapsedOf(record, record.endedAt ?? record.createdAt),
      running: false,
      calls: record.toolCalls,
      tokens: record.tokens,
      cost: record.cost,
    }),
  );
};

type StoredResult = { resultText: string; resultPath?: string; error?: string };

export const storeResult = (record: AgentRecord, text: string): StoredResult => {
  const resultPath = join(record.dir, "result.md");

  try {
    mkdirSync(record.dir, { recursive: true });
    writeFileSync(resultPath, text.endsWith("\n") ? text : `${text}\n`);

    return { resultText: text, resultPath };
  } catch (error) {
    return { resultText: text, error: `result file not written: ${errorText(error)}` };
  }
};

const STATUS_LINE = /^(#+\s*)?status\s*:/i;

const STATUS_SCAN_LINES = 5;

const NON_BLANK_LINE = /[^\n]*\S[^\n]*/g;

const statusWithin = (text: string, start: number, left: number): boolean => {
  NON_BLANK_LINE.lastIndex = start;

  const match = left > 0 ? NON_BLANK_LINE.exec(text) : null;

  if (!match) {
    return false;
  }

  const line = match[0].replace(/[*_`]/g, "").trim();
  const next = match.index + match[0].length + 1;

  if (line.length === 0) {
    return statusWithin(text, next, left);
  }

  return STATUS_LINE.test(line) || statusWithin(text, next, left - 1);
};

const hasStatusLine = (text: string) => statusWithin(text, 0, STATUS_SCAN_LINES);

export const pickResult = (texts: string[]) => {
  const withStatus = texts.findLast(hasStatusLine);

  return { text: (withStatus ?? texts.at(-1) ?? "").trim(), statusLine: withStatus !== undefined };
};

const headCut = (text: string, limit: number) => {
  const newline = text.lastIndexOf("\n", limit);

  return newline > 0 ? newline : limit;
};

const inlineText = (text: string, resultPath: string | undefined, limit: number) => {
  if (!resultPath || text.length <= limit) {
    return [text];
  }

  const cut = headCut(text, limit);
  const head = text.slice(0, cut).trimEnd();
  const marker = `Result file: ${resultPath} (${text.length - cut} more chars)`;

  return head.length > 0 ? [head, marker] : [marker];
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
    cost: links.reduce((sum, link) => sum + link.cost, 0),
  };
};

const chainLine = (links: AgentRecord[]) =>
  `Chain: ${links.map((link) => link.id).join(" → ")} (${links.length} sessions)`;

const resultEntry = (record: AgentRecord, inlineLimit: number, links: AgentRecord[]) => {
  const chained = links.length > 1;
  const lines = [
    `## ${record.id} (${record.agent}) - ${record.state}`,
    `Task: ${cutChars(singleLine(record.description), 200)}`,
  ];

  if (chained) {
    lines.push(chainLine(links));
  }

  lines.push(finishSummary(chained ? chainTotals(links) : record));

  if (record.worktree) {
    lines.push(`Worktree: ${worktreeText(record.worktree)}`);
  }

  if (record.state === "handoff") {
    lines.push(`Handoff file: ${record.handoffPath}${record.error ? ` (invalid: ${record.error})` : ""}`);

    return lines.join("\n");
  }

  const text = record.resultText ?? "";

  if (record.state !== "done" && text.length === 0) {
    return lines.join("\n");
  }

  if (record.state !== "done") {
    lines.push(`(unverified partial output: ${record.error ?? record.state})`);
  } else if (!(record.statusLine ?? hasStatusLine(text))) {
    lines.push("(shape: no Status line)");
  }

  return [...lines, "", ...inlineText(text, record.resultPath, inlineLimit)].join("\n");
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

export const batchMessage = (batchId: string, records: AgentRecord[], inlineLimit: number) => {
  const byId = new Map(records.map((record) => [record.id, record]));
  const terminals = records.filter((record) => isTerminal(record, byId));
  const header = `[pi-subagents] Batch ${batchId} finished: ${countByState(terminals)}.`;

  const entries = terminals.map((record) => resultEntry(record, inlineLimit, chainLinks(byId, record)));

  entries.unshift(header);

  return entries.join("\n\n");
};
