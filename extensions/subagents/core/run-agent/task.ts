import type { AgentRecord } from "../model/agent-record.ts";

type TaskInput = { task: string; files?: string[] };

export const composeTask = (
  record: AgentRecord,
  item: TaskInput,
  predecessor?: AgentRecord,
  undelivered: string[] = [],
) => {
  const files = item.files ?? [];
  const lines = [`Task from ${record.callerId} (agent id ${record.id}):`, `Agent folder: ${record.dir}`];

  if (predecessor) {
    lines.push("Original task:");
  }

  lines.push(item.task);

  if (files.length > 0) {
    lines.push("", "Input files:");

    files.forEach((file) => {
      lines.push(`- ${file}`);
    });
  }

  if (undelivered.length > 0) {
    lines.push("", "Batch results that reached your predecessor after it stopped for the handoff:", "");
    lines.push(undelivered.join("\n\n---\n\n"));
  }

  return lines.join("\n");
};
