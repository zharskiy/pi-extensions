import type { ContextSnapshot, UsageTotals } from "../adapter/contract.ts";
import type { AgentRecord } from "./types.ts";

export type BusEvents = {
  "agent:changed": AgentRecord;
  "agent:turn": { id: string; context: ContextSnapshot; turns: number };
  "agent:closed": AgentRecord;
  "agent:usage": { id: string; usage: UsageTotals };
  "spend:changed": { agentId: string };
};

type Listener<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

export type Bus = {
  on<K extends keyof BusEvents>(event: K, listener: Listener<K>): () => void;
  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void;
};

export const createBus = (onError: (error: unknown) => void = () => {}): Bus => {
  const listeners = new Map<keyof BusEvents, Set<Listener<keyof BusEvents>>>();

  const on = <K extends keyof BusEvents>(event: K, listener: Listener<K>) => {
    const set = listeners.get(event) ?? new Set();

    set.add(listener as Listener<keyof BusEvents>);
    listeners.set(event, set);

    return () => {
      set.delete(listener as Listener<keyof BusEvents>);
    };
  };

  const emit = <K extends keyof BusEvents>(event: K, payload: BusEvents[K]) => {
    const set = listeners.get(event);

    if (!set) {
      return;
    }

    Array.from(set).forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        onError(error);
      }
    });
  };

  return { on, emit };
};
