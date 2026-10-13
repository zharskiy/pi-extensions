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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const record = (id: string) => ({ id }) as AgentRecord;

describe("throttle", () => {
  it("runs at most once per interval and keeps a trailing call", () => {
    const run = vi.fn();
    const throttled = createThrottle(run, () => 250);

    throttled.call();
    throttled.call();
    throttled.call();

    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(249);

    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancel drops the trailing call", () => {
    const run = vi.fn();
    const throttled = createThrottle(run, () => 250);

    throttled.call();
    throttled.call();
    throttled.cancel();
    vi.advanceTimersByTime(1_000);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("agent watch", () => {
  it("throttles relevant changes by throttleMs and ignores irrelevant ones", () => {
    const bus = createBus<BusEvents>();
    const onChange = vi.fn();

    watchAgents(bus, {
      relevant: (changed) => changed.id === "a",
      tickMs: () => undefined,
      throttleMs: () => 250,
      onChange,
    });

    bus.emit("agent:changed", record("a"));
    bus.emit("agent:changed", record("a"));

    expect(onChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(250);

    expect(onChange).toHaveBeenCalledTimes(2);

    bus.emit("agent:changed", record("b"));
    vi.advanceTimersByTime(1_000);

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("ticks every 100 ms while tickMs says so and re-arms at 1000 ms when it changes", () => {
    const bus = createBus<BusEvents>();
    const onChange = vi.fn();
    let tick: number | undefined = 100;

    watchAgents(bus, { relevant: () => true, tickMs: () => tick, throttleMs: () => 0, onChange });

    vi.advanceTimersByTime(1_000);

    expect(onChange).toHaveBeenCalledTimes(10);

    tick = 1_000;
    bus.emit("agent:changed", record("a"));
    onChange.mockClear();
    vi.advanceTimersByTime(999);

    expect(onChange).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1);

    expect(onChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);

    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("stops ticking when tickMs returns undefined and resumes on the next change", () => {
    const bus = createBus<BusEvents>();
    const onChange = vi.fn();
    let tick: number | undefined = 100;

    watchAgents(bus, { relevant: () => true, tickMs: () => tick, throttleMs: () => 0, onChange });

    vi.advanceTimersByTime(100);
    tick = undefined;
    vi.advanceTimersByTime(100);
    onChange.mockClear();
    vi.advanceTimersByTime(5_000);

    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    tick = 100;
    bus.emit("agent:changed", record("a"));

    expect(onChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300);

    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("unrefs the ticker", () => {
    const realSetTimeout = globalThis.setTimeout;
    const unref = vi.fn();

    vi.stubGlobal("setTimeout", (run: () => void, ms: number) => {
      const timer = realSetTimeout(run, ms);

      return Object.assign(timer, { unref });
    });

    const bus = createBus<BusEvents>();

    watchAgents(bus, { relevant: () => true, tickMs: () => 100, throttleMs: () => 0, onChange: () => {} });

    expect(unref).toHaveBeenCalled();
  });

  it("clears everything on unsubscribe", () => {
    const bus = createBus<BusEvents>();
    const onChange = vi.fn();
    const off = watchAgents(bus, {
      relevant: () => true,
      tickMs: () => 100,
      throttleMs: () => 250,
      onChange,
    });

    bus.emit("agent:changed", record("a"));
    bus.emit("agent:changed", record("a"));
    off();
    onChange.mockClear();

    expect(vi.getTimerCount()).toBe(0);

    bus.emit("agent:changed", record("a"));
    vi.advanceTimersByTime(5_000);

    expect(onChange).not.toHaveBeenCalled();
  });
});
