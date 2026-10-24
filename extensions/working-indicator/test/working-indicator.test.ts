import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunMode } from "../../../core/adapter/contract.ts";
import { createFakeHost } from "../../../core/test/helpers/fakes.ts";
import { createWorkingIndicator, TICK_MS, VERB_MS, VERBS } from "../src/working-indicator.ts";

const setup = (mode: RunMode = "tui") => {
  const host = createFakeHost({ mode });

  createWorkingIndicator(host);
  host.start();

  return host;
};

const HINT = "<dim> (<app.interrupt> to interrupt)";

const message = (activity: string, elapsed?: string) => `${activity}${elapsed ? ` · ${elapsed}` : ""}${HINT}`;

const pickIndex = (index: number) => {
  vi.spyOn(Math, "random").mockReturnValue(index / VERBS.length);
};

const WAITING = `${VERBS[0]}...`;

describe("working indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pickIndex(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows a verb from the list and an ellipsis while waiting for the model", () => {
    pickIndex(7);

    const host = setup();

    host.agentStart();

    expect(host.workingMessages).toEqual([message(`${VERBS[7]}...`)]);
  });

  it("keeps the verb between rotations and picks a new one every VERB_MS", () => {
    const host = setup();

    host.agentStart();
    pickIndex(1);
    vi.advanceTimersByTime(VERB_MS - TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(message(WAITING, "7s"));

    host.setPhase("thinking");
    host.setPhase("waiting");

    expect(host.workingMessages.at(-1)).toBe(message(WAITING, "7s"));

    vi.advanceTimersByTime(TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(message(`${VERBS[1]}...`, "8s"));

    pickIndex(2);
    vi.advanceTimersByTime(VERB_MS - TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(message(`${VERBS[1]}...`, "15s"));

    vi.advanceTimersByTime(TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(message(`${VERBS[2]}...`, "16s"));
  });

  it("picks a fresh verb on the next run", () => {
    const host = setup();

    host.agentStart();
    host.settle();
    pickIndex(3);
    host.agentStart();

    expect(host.workingMessages.at(-1)).toBe(message(`${VERBS[3]}...`));
  });

  it("keeps the verb while the model thinks and tools run", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("thinking");
    host.setPhase("toolArgs");
    host.setPhase("tool");
    vi.advanceTimersByTime(TICK_MS);

    expect(host.workingMessages).toEqual([message(WAITING), message(WAITING, "1s")]);
  });

  it("writes pi's ASCII ellipsis, not the ellipsis character", () => {
    const host = setup();

    host.agentStart();

    expect(host.workingMessages.at(-1)).not.toMatch(/…/);
  });

  it("leaves pi's own spinner in place and shows a verb on agent start", () => {
    const host = setup();

    host.agentStart();

    expect(host.workingMessages).toEqual([message(WAITING)]);
  });

  it("shows the elapsed time from one second on", () => {
    const host = setup();

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS - 1);

    expect(host.workingMessages).toEqual([message(WAITING)]);

    vi.advanceTimersByTime(1);

    expect(host.workingMessages.at(-1)).toBe(message(WAITING, "1s"));
  });

  it("advances the elapsed seconds every tick and switches to minutes after one minute", () => {
    const host = setup();

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages.at(-1)).toBe(message(WAITING, "3s"));

    vi.advanceTimersByTime(TICK_MS * 62);

    expect(host.workingMessages.at(-1)).toBe(message(WAITING, "1m 5s"));
    expect(host.workingMessages.some((text) => text?.includes("65s"))).toBe(false);
  });

  it("keeps counting across turns of one run", () => {
    const host = setup();

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS * 5);
    host.turnEnd({ tokens: 10, window: 100 });

    expect(host.workingMessages.at(-1)).toBe(message(WAITING, "5s"));
    expect(host.workingMessages).not.toContain(undefined);
  });

  it("clears the message and stops ticking when the run settles", () => {
    const host = setup();

    host.agentStart();
    host.settle();
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages).toEqual([message(WAITING), undefined]);
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
    expect(host.workingVisibility).toEqual([]);
  });

  it("restarts the clock on the next run", () => {
    const host = setup();

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS * 5);
    host.settle();
    host.agentStart();

    expect(host.workingMessages.slice(-2)).toEqual([undefined, message(WAITING)]);
  });

  it("nothing outside tui", () => {
    const host = setup("print");

    host.agentStart();
    host.setPhase("writing");
    host.setPhase("tool");
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages).toEqual([]);
    expect(host.workingVisibility).toEqual([]);
  });

  it("hides while the assistant writes text and shows again when a tool starts", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("writing");

    expect(host.workingVisibility).toEqual([false]);

    host.setPhase("tool");

    expect(host.workingVisibility).toEqual([false, true]);
    expect(host.workingMessages.at(-1)).toBe(message(WAITING));
  });

  it("shows the row again with the current message", () => {
    const host = setup();
    const write = vi.spyOn(host.ui, "setWorkingMessage");
    const show = vi.spyOn(host.ui, "setWorkingVisible");

    host.agentStart();
    host.setPhase("writing");
    host.setPhase("tool");

    const showCall = show.mock.calls.findIndex(([visible]) => visible);
    const lastWrite = write.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY;

    expect(write.mock.calls.at(-1)).toEqual([message(WAITING)]);
    expect(lastWrite).toBeLessThan(show.mock.invocationCallOrder[showCall] ?? 0);
  });

  it("shows again when the text ends without a tool", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("writing");
    host.setPhase("waiting");

    expect(host.workingVisibility).toEqual([false, true]);
    expect(host.workingMessages.at(-1)).toBe(message(WAITING));
  });

  it("keeps the row for thinking, tool arguments and tools", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("waiting");
    host.setPhase("thinking");
    host.setPhase("toolArgs");
    host.setPhase("tool");
    host.setPhase("waiting");

    expect(host.workingVisibility).toEqual([]);
  });

  it("keeps ticking while hidden", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("writing");
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages.at(-1)).toBe(message(WAITING, "3s"));
    expect(host.workingVisibility).toEqual([false]);
  });

  it("keeps the clock across a repeated agent_start", () => {
    const host = setup();
    const keyText = vi.spyOn(host.ui, "keyText");

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS * 5);
    host.agentStart();

    expect(host.workingMessages.at(-1)).toBe(message(WAITING, "5s"));
    expect(host.workingMessages.slice(1)).not.toContain(message(WAITING));
    expect(host.workingMessages.slice(1)).not.toContain(message(WAITING, "0s"));
    expect(keyText).toHaveBeenCalledTimes(1);
  });

  it("ignores phases before a run starts", () => {
    const host = setup();

    host.setPhase("writing");
    host.setPhase("tool");

    expect(host.workingMessages).toEqual([]);
    expect(host.workingVisibility).toEqual([]);
  });

  it("restores the row flag and clears the message on settle", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("writing");
    host.settle();

    const written = host.workingMessages.length;

    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingVisibility).toEqual([false, true]);
    expect(host.workingMessages.at(-1)).toBeUndefined();
    expect(host.workingMessages).toHaveLength(written);
  });

  it("leaves visibility to pi on shutdown", async () => {
    const host = setup();

    host.agentStart();
    host.setPhase("writing");
    await host.shutdown();

    const written = host.workingMessages.length;

    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingVisibility).toEqual([false]);
    expect(host.workingMessages.at(-1)).toBeUndefined();
    expect(host.workingMessages).toHaveLength(written);
  });
});
