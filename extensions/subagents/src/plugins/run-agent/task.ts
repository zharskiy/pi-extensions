import type { AgentRecord } from "../../model/types.ts";

type TaskInput = { task: string; files?: string[] };

export const composeTask = (
  record: AgentRecord,
  item: TaskInput,
  predecessor?: AgentRecord,
  undelivered: string[] = [],
) => {
  const files = predecessor ? [predecessor.handoffPath].concat(item.files ?? []) : (item.files ?? []);
  const lines = [`Task from ${record.callerId} (agent id ${record.id}):`];

  if (predecessor) {
    lines.push(
      `You continue the work of agent ${predecessor.id} as link ${record.chainIndex} of its chain; it reached its context limit and wrote a handoff file.`,
      `Read the handoff file at ${predecessor.handoffPath} first, then carry on from its Next section without redoing the work it reports as done.`,
      "",
      "Original task:",
    );
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
