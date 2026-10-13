import type { Bus } from "../model/events.ts";
import type { AgentRecord } from "../model/types.ts";

export type Throttle = { call(): void; cancel(): void };

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

export type AgentWatch = {
  relevant(record: AgentRecord): boolean;
  tickMs(): number | undefined;
  throttleMs(): number;
  onChange(): void;
};

export const watchAgents = (bus: Bus, watch: AgentWatch): (() => void) => {
  const throttled = createThrottle(watch.onChange, watch.throttleMs);
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
