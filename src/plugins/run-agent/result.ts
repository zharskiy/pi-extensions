import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finishSummary, singleLine, truncate } from "../../components/agent-row.ts";
import type { AgentRecord } from "../../manager/types.ts";

export const RESULT_FILE = "result.md";

export const PREVIEW_CHARS = 300;

export type StoredResult = { resultText: string; resultPath: string };

export const storeResult = (record: AgentRecord, text: string): StoredResult => {
  const resultPath = join(record.dir, RESULT_FILE);

  mkdirSync(record.dir, { recursive: true });
  writeFileSync(resultPath, text.endsWith("\n") ? text : `${text}\n`);

  return { resultText: text, resultPath };
};

export const shouldInline = (record: AgentRecord, inlineLimit: number, forceFile: boolean) => {
  if (forceFile || record.state === "handoff") {
    return false;
  }

  return (record.resultText ?? "").length <= inlineLimit;
};

export const resultEntry = (record: AgentRecord, inlineLimit: number, forceFile: boolean, now: number) => {
  const header = `## ${record.id} (${record.agent}) - ${record.state}`;
  const lines = [
    header,
    `Task: ${truncate(singleLine(record.description), 200)}`,
    finishSummary(record, now),
  ];

  if (record.state === "handoff") {
    lines.push(`Handoff file: ${record.handoffPath}`);

    return lines.join("\n");
  }

  const carriesResult = record.state === "done" || (record.state === "stopped" && Boolean(record.resultText));

  if (!carriesResult) {
    return lines.join("\n");
  }

  if (shouldInline(record, inlineLimit, forceFile)) {
    lines.push("", record.resultText ?? "");

    return lines.join("\n");
  }

  const size = (record.resultText ?? "").length;
  const preview = truncate(singleLine(record.resultText ?? ""), PREVIEW_CHARS);

  lines.push(`Result file: ${record.resultPath} (${size} chars)`, `Preview: ${preview}`);

  return lines.join("\n");
};

export const countByState = (records: AgentRecord[]) => {
  const counts = records.reduce<Record<string, number>>((tally, record) => {
    tally[record.state] = (tally[record.state] ?? 0) + 1;
    return tally;
  }, {});

  return Object.entries(counts)
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
};

export const batchMessage = (
  batchId: string,
  records: AgentRecord[],
  inlineLimit: number,
  fileOutputs: ReadonlySet<string>,
  now: number,
) => {
  const header = `[pi-subagents] Batch ${batchId} finished: ${countByState(records)}.`;
  const entries = records.map((record) => resultEntry(record, inlineLimit, fileOutputs.has(record.id), now));

  entries.unshift(header);

  return entries.join("\n\n");
};
