import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../../../extension-manager/index.ts";
import { tickFor, watchAgents } from "../../core/components/refresh.ts";
import type { AgentRecord, AgentState } from "../../core/model/agent-record.ts";
import type { BusEvents } from "../../core/model/events.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const record = (id: string, state: AgentState = "running") => ({ id, state }) as AgentRecord;

describe("tick cadence", () => {
  it.each([
    { name: "100 ms while a record runs", records: ["running", "done"], linger: false, expected: 100 },
    { name: "100 ms while a record is in grace", records: ["grace"], linger: false, expected: 100 },
    { name: "1 s while a record is queued", records: ["queued", "done"], linger: false, expected: 1_000 },
    { name: "1 s for lingering closed records", records: ["done", "failed"], linger: true, expected: 1_000 },
    { name: "none for closed records without linger", records: ["done"], linger: false, expected: undefined },
    { name: "none without records", records: [], linger: true, expected: undefined },
  ] as { name: string; records: AgentState[]; linger: boolean; expected: number | undefined }[])(
    "$name",
    ({ records, linger, expected }) => {
      expect(
        tickFor(
          records.map((state, index) => record(`r${index}`, state)),
          linger,
        ),
      ).toBe(expected);
    },
  );
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
    bus.emit("agent:changed", record("a"));

    expect(onChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(249);

    expect(onChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);

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

  it("arms the ticker from the cadence a trailing change computed", () => {
    const bus = createBus<BusEvents>();
    let seen: number | undefined;
    let tick: number | undefined;
    const onChange = vi.fn(() => {
      tick = seen;
    });

    watchAgents(bus, { relevant: () => true, tickMs: () => tick, throttleMs: () => 250, onChange });

    bus.emit("agent:changed", record("a"));
    seen = 100;
    bus.emit("agent:changed", record("a"));
    vi.advanceTimersByTime(250);

    expect(onChange).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(300);

    expect(onChange).toHaveBeenCalledTimes(5);
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
