import type { Bus } from "../model/events.ts";
import type { AgentRecord } from "../model/types.ts";

const REFRESH_MS = 300;

const TICK_MS = 1_000;

export const createThrottle = (run: () => void, intervalMs: () => number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = Number.NEGATIVE_INFINITY;

  const fire = () => {
    timer = undefined;
    last = Date.now();
    run();
  };

  const throttled = () => {
    if (timer) {
      return;
    }

    const wait = last + intervalMs() - Date.now();

    if (wait <= 0) {
      fire();
      return;
    }

    timer = setTimeout(fire, wait);
  };

  throttled.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return throttled;
};

type AgentWatch = {
  relevant(record: AgentRecord): boolean;
  ticking(): boolean;
  onChange(): void;
};

export const watchAgents = (bus: Bus, watch: AgentWatch) => {
  const throttled = createThrottle(watch.onChange, () => REFRESH_MS);

  const off = bus.on("agent:changed", (record) => {
    if (watch.relevant(record)) {
      throttled();
    }
  });

  const ticker = setInterval(() => {
    if (watch.ticking()) {
      watch.onChange();
    }
  }, TICK_MS);

  return () => {
    off();
    throttled.cancel();
    clearInterval(ticker);
  };
};
