import type { ContextSnapshot, UsageTotals } from "../../../../core/adapter/contract.ts";
import type { Bus as CoreBus } from "../../../../core/manager/bus.ts";
import type { AgentRecord } from "./types.ts";

export type BusEvents = {
  "agent:changed": AgentRecord;
  "agent:turn": { id: string; context: ContextSnapshot; turns: number; continuing: boolean };
  "agent:closed": AgentRecord;
  "agent:usage": { id: string; usage: UsageTotals };
  "batch:settled": { batchId: string; callerId: string; terminals: AgentRecord[] };
};

export type Bus = CoreBus<BusEvents>;
