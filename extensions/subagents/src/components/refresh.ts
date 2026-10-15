import type { Bus } from "../model/events.ts";
import type { AgentRecord } from "../model/types.ts";

const TICK_RUNNING_MS = 100;

const TICK_IDLE_MS = 1_000;

export const tickFor = (records: AgentRecord[], linger: boolean): number | undefined => {
  if (records.some((record) => record.state === "running" || record.state === "grace")) {
    return TICK_RUNNING_MS;
  }

  if (records.some((record) => record.state === "queued") || (linger && records.length > 0)) {
    return TICK_IDLE_MS;
  }

  return undefined;
};

type Throttle = { call(): void; cancel(): void };

export const createThrottle = (run: () => void, intervalMs: () => number): Throttle => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = Number.NEGATIVE_INFINITY;

  const fire = () => {
    timer = undefined;
    last = Date.now();
    run();
  };

  return {
    call: () => {
      if (timer) {
        return;
      }

      const wait = last + intervalMs() - Date.now();

      if (wait <= 0) {
        fire();
        return;
      }

      timer = setTimeout(fire, wait);
      timer.unref?.();
    },
    cancel: () => {
      clearTimeout(timer);
      timer = undefined;
    },
  };
};

type AgentWatch = {
  relevant(record: AgentRecord): boolean;
  tickMs(): number | undefined;
  throttleMs(): number;
  onChange(): void;
};

export const watchAgents = (bus: Bus, watch: AgentWatch): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armedMs: number | undefined;

  const arm = () => {
    const wanted = watch.tickMs();

    if (wanted === armedMs) {
      return;
    }

    clearTimeout(timer);
    timer = undefined;
    armedMs = wanted;

    if (wanted !== undefined) {
      timer = setTimeout(tick, wanted);
      timer.unref?.();
    }
  };

  const tick = () => {
    timer = undefined;
    armedMs = undefined;
    watch.onChange();
    arm();
  };

  const throttled = createThrottle(() => {
    watch.onChange();
    arm();
  }, watch.throttleMs);

  const off = bus.on("agent:changed", (record) => {
    if (watch.relevant(record)) {
      throttled.call();
      arm();
    }
  });

  arm();

  return () => {
    off();
    throttled.cancel();
    clearTimeout(timer);
    timer = undefined;
  };
};
