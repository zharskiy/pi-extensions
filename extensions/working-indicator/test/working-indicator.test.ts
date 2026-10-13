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

describe("working indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pickIndex(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("formats the verb and the elapsed seconds", () => {
    expect(workingMessage("Musing", 12_345)).toBe("Musing… (12s · esc to interrupt)");
  });

  it("applies the spinner at session start", () => {
    const host = setup();

    expect(host.workingIndicators).toEqual([spinner]);
  });

  it("applies the spinner and shows the first message on turn start", () => {
    const host = setup();

    host.turnStart();

    expect(host.workingIndicators).toEqual([spinner, spinner]);
    expect(host.workingMessages).toEqual([`${VERBS[0]}… (0s · esc to interrupt)`]);
  });

  it("advances the elapsed seconds every tick", () => {
    const host = setup();

    host.turnStart();
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages.at(-1)).toBe(`${VERBS[0]}… (3s · esc to interrupt)`);
  });

  it("picks a new verb once VERB_MS has passed", () => {
    const host = setup();

    host.turnStart();
    pickIndex(1);
    vi.advanceTimersByTime(VERB_MS - TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(`${VERBS[0]}… (7s · esc to interrupt)`);

    vi.advanceTimersByTime(TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(`${VERBS[1]}… (8s · esc to interrupt)`);
  });

  it("clears the message and stops ticking on turn end", () => {
    const host = setup();

    host.turnStart();
    host.turnEnd({ tokens: 10, window: 100 });
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages).toEqual([`${VERBS[0]}… (0s · esc to interrupt)`, undefined]);
  });

  it("clears the message on shutdown", async () => {
    const host = setup();

    host.turnStart();
    await host.shutdown();
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages.at(-1)).toBeUndefined();
    expect(host.workingMessages).toHaveLength(2);
  });

  it("leaves the message alone when no turn is running", async () => {
    const host = setup();

    host.turnEnd({ tokens: 10, window: 100 });
    await host.shutdown();

    expect(host.workingMessages).toEqual([]);
  });

  it("restarts the clock on the next turn", () => {
    const host = setup();

    host.turnStart();
    vi.advanceTimersByTime(TICK_MS * 5);
    host.turnStart();

    expect(host.workingMessages.slice(-2)).toEqual([undefined, `${VERBS[0]}… (0s · esc to interrupt)`]);
  });

  it("does nothing outside tui mode", () => {
    const host = setup("print");

    host.turnStart();
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingIndicators).toEqual([]);
    expect(host.workingMessages).toEqual([]);
  });
});
