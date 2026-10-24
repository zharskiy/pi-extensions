import type { Phase } from "../types/session.ts";

export type PhaseState = { phase: Phase; running: ReadonlySet<string> };

type DeltaBlock = "text" | "thinking" | "toolcall";

type DeltaEdge = "start" | "delta" | "end";

type ClearingType = "agent_start" | "turn_start" | "agent_end" | "agent_settled";

export type PhaseEvent =
  | { type: ClearingType }
  | { type: "delta"; block: DeltaBlock; edge: DeltaEdge }
  | { type: "message_end" }
  | { type: "tool_start"; id: string }
  | { type: "tool_end"; id: string };

export const ASSISTANT_DELTA_TYPES = [
  "text_start",
  "text_delta",
  "text_end",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
] as const;

const DELTAS = new Map<string, PhaseEvent>(
  ASSISTANT_DELTA_TYPES.map((type) => {
    const [block, edge] = type.split("_") as [DeltaBlock, DeltaEdge];

    return [type, { type: "delta", block, edge }];
  }),
);

const STREAMING: Record<DeltaBlock, Phase> = { text: "writing", thinking: "thinking", toolcall: "toolArgs" };

const CLEARING: Record<ClearingType, Phase> = {
  agent_start: "waiting",
  turn_start: "waiting",
  agent_end: "waiting",
  agent_settled: "idle",
};

export const initialPhase = (): PhaseState => ({ phase: "idle", running: new Set() });

export const deltaEvent = (assistantEventType: string): PhaseEvent | undefined =>
  DELTAS.get(assistantEventType);

const withPhase = (state: PhaseState, phase: Phase): PhaseState =>
  state.phase === phase ? state : { phase, running: state.running };

const cleared = (state: PhaseState, phase: Phase): PhaseState =>
  state.phase === phase && state.running.size === 0 ? state : { phase, running: new Set() };

export const reducePhase = (state: PhaseState, event: PhaseEvent): PhaseState => {
  if (event.type === "delta") {
    return withPhase(state, event.edge === "end" ? "waiting" : STREAMING[event.block]);
  }

  if (event.type === "message_end") {
    return withPhase(state, "waiting");
  }

  if (event.type === "tool_start") {
    return { phase: "tool", running: new Set(state.running).add(event.id) };
  }

  if (event.type === "tool_end") {
    if (!state.running.has(event.id)) {
      return state;
    }

    const running = new Set(state.running);

    running.delete(event.id);

    return { phase: running.size > 0 ? "tool" : "waiting", running };
  }

  return cleared(state, CLEARING[event.type]);
};
