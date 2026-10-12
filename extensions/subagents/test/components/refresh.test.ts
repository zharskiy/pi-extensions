import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../../../core/manager/bus.ts";
import { createThrottle, watchAgents } from "../../src/components/refresh.ts";
import type { BusEvents } from "../../src/model/events.ts";
import type { AgentRecord } from "../../src/model/types.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("throttle", () => {
  it("runs at most once per interval and keeps a trailing call", () => {
    const run = vi.fn();
    const throttled = createThrottle(run, () => 250);

    throttled();
    throttled();
    throttled();

    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(249);

    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);

    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("agent watch", () => {
  it("throttles relevant changes, ticks while asked to and stops after unsubscribe", () => {
    const bus = createBus<BusEvents>();
    const onChange = vi.fn();
    let ticking = true;
    const record = (id: string) => ({ id }) as AgentRecord;

    const off = watchAgents(bus, {
      relevant: (changed) => changed.id === "a",
      ticking: () => ticking,
      onChange,
    });

    bus.emit("agent:changed", record("b"));

    expect(onChange).not.toHaveBeenCalled();

    bus.emit("agent:changed", record("a"));
    bus.emit("agent:changed", record("a"));
    vi.advanceTimersByTime(300);

    expect(onChange).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1_000);

    expect(onChange).toHaveBeenCalledTimes(3);

    ticking = false;
    vi.advanceTimersByTime(1_000);

    expect(onChange).toHaveBeenCalledTimes(3);

    off();
    ticking = true;
    bus.emit("agent:changed", record("a"));
    vi.advanceTimersByTime(5_000);

    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
