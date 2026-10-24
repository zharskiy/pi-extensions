import type { AgentRecord, NewAgent } from "../../core/model/agent-record.ts";

export { type AgentRecord, chainLinks, chainTerminal, isClosed } from "../../core/model/agent-record.ts";

export const agentRecord = (patch: Partial<AgentRecord> & { id: string }): AgentRecord => ({
  agent: "explorer",
  description: `work of ${patch.id}`,
  callerId: "main",
  depth: 2,
  batchId: "b-1",
  chainIndex: 1,
  state: "running",
  createdAt: 0,
  startedAt: 0,
  turns: 0,
  toolCalls: 0,
  tokens: 0,
  cost: 0,
  lastText: "",
  handoffPath: "/x/handoff.md",
  dir: "/x",
  contextLimit: 100_000,
  handoffRequested: false,
  ...patch,
});

export const newAgentInput = (dir: string, patch: Partial<NewAgent> = {}): NewAgent => ({
  agent: "explorer",
  description: "look around",
  callerId: "main",
  depth: 2,
  batchId: "b-1",
  dir,
  contextLimit: 100_000,
  ...patch,
});
