import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunMode, SpawnSpec } from "../../../core/adapter/contract.ts";
import { BUSY_CHANNEL } from "../../../core/manager/channels.ts";
import { createFakeHost, createFakeRuntime } from "../../../core/test/helpers/fakes.ts";
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

const message = (verb: string | undefined, elapsed: string, tool?: string) =>
  `${verb}… (${tool ? `${tool} · ` : ""}${elapsed} · <app.interrupt> to interrupt)`;

const V0 = VERBS[0];

const spec: SpawnSpec = {
  id: "explorer-1",
  cwd: "/tmp/pi-extensions-test",
  sessionDir: "/tmp/pi-extensions-test/agents/explorer-1",
  model: "fake/model",
  thinking: "off",
  promptAppend: [],
  reserveTokens: 0,
  customTools: [],
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

  it("applies the spinner at session start", () => {
    const host = setup();

    expect(host.workingIndicators).toEqual([spinner]);
  });

  it("shows the first message on agent start without re-setting the spinner", () => {
    const host = setup();

    host.agentStart();

    expect(host.workingIndicators).toEqual([spinner]);
    expect(host.workingMessages).toEqual([message(V0, "0s")]);
  });

  it("advances the elapsed seconds every tick", () => {
    const host = setup();

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages.at(-1)).toBe(message(V0, "3s"));
  });

  it("picks a new verb every VERB_MS", () => {
    const host = setup();

    host.agentStart();
    pickIndex(1);
    vi.advanceTimersByTime(VERB_MS - TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(message(V0, "7s"));

    vi.advanceTimersByTime(TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(message(VERBS[1], "8s"));

    pickIndex(2);
    vi.advanceTimersByTime(VERB_MS);

    expect(host.workingMessages.at(-1)).toBe(message(VERBS[2], "16s"));
  });

  it("keeps counting across turns of one run", () => {
    const host = setup();

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS * 5);
    host.turnEnd({ tokens: 10, window: 100 });

    expect(host.workingMessages.at(-1)).toBe(message(V0, "5s"));
    expect(host.workingMessages).not.toContain(undefined);
  });

  it("clears the message and stops ticking when the run settles", () => {
    const host = setup();

    host.agentStart();
    host.settle();
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages).toEqual([message(V0, "0s"), undefined]);
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

    expect(host.workingMessages.slice(-2)).toEqual([undefined, message(V0, "0s")]);
  });

  it("formats the verb, the elapsed time, the tool and the interrupt key", () => {
    expect(workingMessage("Musing", 12_345, "esc")).toBe("Musing… (12s · esc to interrupt)");
    expect(workingMessage("Musing", 65_000, "esc", "bash")).toBe("Musing… (bash · 1m 5s · esc to interrupt)");
  });

  it("nothing outside tui", () => {
    const host = setup("print");

    host.agentStart();
    host.setPhase("writing");
    host.setPhase("tool", { toolName: "bash", running: 1 });
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages).toEqual([]);
    expect(host.workingVisibility).toEqual([]);
  });

  it("formats elapsed times with the shared duration format", () => {
    expect(workingMessage("Musing", 45_000, "esc")).toBe("Musing… (45s · esc to interrupt)");
    expect(workingMessage("Musing", 3_723_000, "esc")).toBe("Musing… (1h 2m · esc to interrupt)");
  });

  it("switches to minutes after one minute", () => {
    const host = setup();

    host.agentStart();
    pickIndex(0);
    vi.advanceTimersByTime(TICK_MS * 65);

    expect(host.workingMessages.at(-1)).toBe(message(V0, "1m 5s"));
    expect(host.workingMessages.some((text) => text?.includes("65s"))).toBe(false);
  });

  it("hides while the assistant writes text and shows again when a tool starts", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("writing");

    expect(host.workingVisibility).toEqual([false]);

    host.setPhase("tool", { toolName: "bash", running: 1 });

    expect(host.workingVisibility).toEqual([false, true]);
    expect(host.workingMessages.at(-1)).toBe(message(V0, "0s", "bash"));
  });

  it("writes the fresh message before showing the row again", () => {
    const host = setup();
    const write = vi.spyOn(host.ui, "setWorkingMessage");
    const show = vi.spyOn(host.ui, "setWorkingVisible");

    host.agentStart();
    host.setPhase("writing");
    host.setPhase("tool", { toolName: "bash", running: 1 });

    const showCall = show.mock.calls.findIndex(([visible]) => visible);
    const lastWrite = write.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY;

    expect(write.mock.calls.at(-1)).toEqual([message(V0, "0s", "bash")]);
    expect(lastWrite).toBeLessThan(show.mock.invocationCallOrder[showCall] ?? 0);
  });

  it("shows again when the text ends without a tool", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("writing");
    host.setPhase("waiting");

    expect(host.workingVisibility).toEqual([false, true]);
    expect(host.workingMessages.at(-1)).toBe(message(V0, "0s"));
  });

  it("keeps the row for thinking, tool arguments and tools", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("waiting");
    host.setPhase("thinking");
    host.setPhase("toolArgs");
    host.setPhase("tool", { toolName: "bash", running: 1 });
    host.setPhase("waiting");

    expect(host.workingVisibility).toEqual([]);
  });

  it("names the running tool", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("tool", { toolName: "bash", running: 1 });
    vi.advanceTimersByTime(TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(message(V0, "1s", "bash"));

    host.setPhase("tool", { toolName: "grep", running: 2 });

    expect(host.workingMessages.at(-1)).toBe(message(V0, "1s", "grep"));

    host.setPhase("waiting");

    expect(host.workingMessages.at(-1)).toBe(message(V0, "1s"));
  });

  it("shows run_agent for a waiting batch", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("tool", { toolName: "run_agent", running: 1 });
    vi.advanceTimersByTime(TICK_MS * 65);

    expect(host.workingMessages.at(-1)).toBe(message(V0, "1m 5s", "run_agent"));
  });

  it("keeps ticking while hidden", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("writing");
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages.at(-1)).toBe(message(V0, "3s"));
    expect(host.workingVisibility).toEqual([false]);
  });

  it("keeps the clock across a repeated agent_start", () => {
    const host = setup();
    const keyText = vi.spyOn(host.ui, "keyText");

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS * 5);
    pickIndex(3);
    host.agentStart();

    expect(host.workingMessages.at(-1)).toBe(message(V0, "5s"));
    expect(host.workingMessages.slice(1)).not.toContain(message(V0, "0s"));
    expect(host.workingMessages.slice(1)).not.toContain(message(VERBS[3], "0s"));
    expect(keyText).toHaveBeenCalledTimes(1);
  });

  it("ignores phases before a run starts", () => {
    const host = setup();

    host.setPhase("writing");
    host.setPhase("tool", { toolName: "bash", running: 1 });

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

  it("ignores child sessions, channels and other host events", async () => {
    const host = setup();
    const runtime = createFakeRuntime();
    const child = await runtime.spawn(spec);
    const fake = runtime.child(child.id);

    host.agentStart();
    host.setPhase("tool", { toolName: "run_agent", running: 1 });

    const messages = host.workingMessages.length;
    const visibility = host.workingVisibility.length;
    const phases = host.phases.length;

    fake.emit({ type: "tool_start", toolName: "bash" });
    fake.turn({ tokens: 10 });
    fake.finish("done");
    host.emit(BUSY_CHANNEL, { source: "subagents", busy: false });
    host.turnEnd({ tokens: 10, window: 100 });
    host.compact();

    expect(host.workingMessages).toHaveLength(messages);
    expect(host.workingVisibility).toHaveLength(visibility);
    expect(host.phases).toHaveLength(phases);
    expect(host.phase()).toEqual({ phase: "tool", detail: { toolName: "run_agent", running: 1 } });

    vi.advanceTimersByTime(TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(message(V0, "1s", "run_agent"));
  });
});
