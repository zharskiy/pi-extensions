import type { AgentRecord } from "../../src/model/types.ts";

/** A plain running record for pure row, tree and panel tests; `patch` overrides any field. */
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
  lastText: "",
  handoffPath: "/x/handoff.md",
  dir: "/x",
  contextLimit: 100_000,
  handoffRequested: false,
  version: 0,
  ...patch,
});
