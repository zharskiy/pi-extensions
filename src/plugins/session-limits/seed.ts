import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "../../adapter/contract.ts";
import type { AgentRecord } from "../../manager/types.ts";

export const MAIN_HANDOFF_FILE = "main-handoff.md";

export const mainHandoffPath = (info: SessionInfo | undefined) => {
  if (!info) {
    return join(tmpdir(), "pi-subagents", "no-session", MAIN_HANDOFF_FILE);
  }

  if (info.file) {
    return join(info.file.replace(/\.jsonl$/, ""), MAIN_HANDOFF_FILE);
  }

  return join(tmpdir(), "pi-subagents", info.id, MAIN_HANDOFF_FILE);
};

const lateAgentLine = (record: AgentRecord) =>
  `- ${record.id} (${record.agent}): ${record.state}, result: ${record.resultPath ?? "none"}`;

export const seedText = (previousSession: string | undefined, handoff: string, lateAgents: AgentRecord[]) => {
  const source = previousSession ? `the previous session ${previousSession}` : "the previous session";

  const preface = `This session continues ${source}, which reached its context limit. Its handoff follows; use it as your context and keep helping the user from where it left off.`;

  const late =
    lateAgents.length === 0
      ? []
      : ["", "## Agents that finished after the handoff was written", ...lateAgents.map(lateAgentLine)];

  return [preface, "", handoff.trim(), ...late].join("\n");
};
