import type { ContextSnapshot, UsageTotals } from "../../../../platform/pi-adapter/index.ts";
import type { Bus as CoreBus } from "../../../../platform/shared/index.ts";
import type { AgentRecord } from "./agent-record.ts";

export type BusEvents = {
  "agent:changed": AgentRecord;
  "agent:turn": { id: string; context: ContextSnapshot; turns: number; continuing: boolean };
  "agent:closed": AgentRecord;
  "agent:usage": { id: string; usage: UsageTotals };
  "batch:started": { batchId: string; callerId: string };
  "batch:settled": { batchId: string };
};

export type Bus = CoreBus<BusEvents>;
