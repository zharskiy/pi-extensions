import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunMode } from "../../../core/adapter/contract.ts";
import { createFakeHost } from "../../../core/test/helpers/fakes.ts";
import {
  createWorkingIndicator,
  spinner,
  TICK_MS,
  VERB_MS,
  VERBS,
  workingMessage,
} from "../src/working-indicator.ts";

const setup = (mode: RunMode = "tui") => {
  const host = createFakeHost({ mode });

  createWorkingIndicator(host);
  host.start();

  return host;
};

const pickIndex = (index: number) => {
  vi.spyOn(Math, "random").mockReturnValue(index / VERBS.length);
};

const message = (verb: string | undefined, seconds: number) =>
  `${verb}… (${seconds}s · <app.interrupt> to interrupt)`;

describe("working indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pickIndex(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("formats the verb, the elapsed seconds and the interrupt key", () => {
    expect(workingMessage("Musing", 12_345, "esc")).toBe("Musing… (12s · esc to interrupt)");
  });

  it("applies the spinner at session start", () => {
    const host = setup();

    expect(host.workingIndicators).toEqual([spinner]);
  });

  it("shows the first message on agent start without re-setting the spinner", () => {
    const host = setup();

    host.agentStart();

    expect(host.workingIndicators).toEqual([spinner]);
    expect(host.workingMessages).toEqual([message(VERBS[0], 0)]);
  });

  it("advances the elapsed seconds every tick", () => {
    const host = setup();

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages.at(-1)).toBe(message(VERBS[0], 3));
  });

  it("picks a new verb every VERB_MS", () => {
    const host = setup();

    host.agentStart();
    pickIndex(1);
    vi.advanceTimersByTime(VERB_MS - TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(message(VERBS[0], 7));

    vi.advanceTimersByTime(TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(message(VERBS[1], 8));

    pickIndex(2);
    vi.advanceTimersByTime(VERB_MS);

    expect(host.workingMessages.at(-1)).toBe(message(VERBS[2], 16));
  });

  it("keeps counting across turns of one run", () => {
    const host = setup();

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS * 5);
    host.turnEnd({ tokens: 10, window: 100 });

    expect(host.workingMessages.at(-1)).toBe(message(VERBS[0], 5));
    expect(host.workingMessages).not.toContain(undefined);
  });

  it("clears the message and stops ticking when the run settles", () => {
    const host = setup();

    host.agentStart();
    host.settle();
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages).toEqual([message(VERBS[0], 0), undefined]);
  });

  it("clears the message on shutdown", async () => {
    const host = setup();

    host.agentStart();
    await host.shutdown();
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages.at(-1)).toBeUndefined();
    expect(host.workingMessages).toHaveLength(2);
  });

  it("leaves the message alone when no run is active", async () => {
    const host = setup();

    host.settle();
    await host.shutdown();

    expect(host.workingMessages).toEqual([]);
  });

  it("restarts the clock on the next run", () => {
    const host = setup();

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS * 5);
    host.settle();
    host.agentStart();

    expect(host.workingMessages.slice(-2)).toEqual([undefined, message(VERBS[0], 0)]);
  });

  it("does nothing outside tui mode", () => {
    const host = setup("print");

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages).toEqual([]);
  });
});
