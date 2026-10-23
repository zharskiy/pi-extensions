import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunMode, RunningTool } from "../../../core/adapter/contract.ts";
import { createFakeHost, plainTheme } from "../../../core/test/helpers/fakes.ts";
import { createWorkingIndicator, TICK_MS } from "../src/working-indicator.ts";

const HOME = "/home/me";

const setup = (mode: RunMode = "tui", columns?: number) => {
  const host = createFakeHost({ mode });

  host.workingColumns = columns;
  createWorkingIndicator(host, HOME);
  host.start();

  return host;
};

const HINT = "<dim> (<app.interrupt> to interrupt)";

const message = (activity: string, elapsed?: string) => `${activity}${elapsed ? ` · ${elapsed}` : ""}${HINT}`;

const WAITING = "Waiting for the model";

describe("working indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("leaves pi's own spinner in place and waits for the model on agent start", () => {
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
    host.setPhase("tool", { toolName: "bash" });
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(host.workingMessages).toEqual([]);
    expect(host.workingVisibility).toEqual([]);
  });

  it("hides while the assistant writes text and shows again when a tool starts", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("writing");

    expect(host.workingVisibility).toEqual([false]);

    host.setPhase("tool", { toolName: "bash" });

    expect(host.workingVisibility).toEqual([false, true]);
    expect(host.workingMessages.at(-1)).toBe(message("Running bash"));
  });

  it("writes the fresh message before showing the row again", () => {
    const host = setup();
    const write = vi.spyOn(host.ui, "setWorkingMessage");
    const show = vi.spyOn(host.ui, "setWorkingVisible");

    host.agentStart();
    host.setPhase("writing");
    host.setPhase("tool", { toolName: "bash" });

    const showCall = show.mock.calls.findIndex(([visible]) => visible);
    const lastWrite = write.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY;

    expect(write.mock.calls.at(-1)).toEqual([message("Running bash")]);
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
    host.setPhase("tool", { toolName: "bash" });
    host.setPhase("waiting");

    expect(host.workingVisibility).toEqual([]);
  });

  it("names the running tool", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("tool", { toolName: "bash" });
    vi.advanceTimersByTime(TICK_MS);

    expect(host.workingMessages.at(-1)).toBe(message("Running bash", "1s"));

    host.setPhase("tool", { toolName: "grep" });

    expect(host.workingMessages.at(-1)).toBe(message("Running grep", "1s"));

    host.setPhase("waiting");

    expect(host.workingMessages.at(-1)).toBe(message(WAITING, "1s"));
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
    host.setPhase("tool", { toolName: "bash" });

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

describe("working activity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const during = (tools: RunningTool[], columns?: number) => {
    const host = setup("tui", columns);

    host.agentStart();
    vi.advanceTimersByTime(TICK_MS * 12);
    host.setPhase("tool", { toolName: tools.at(-1)?.name, tools });

    return host.workingMessages.at(-1);
  };

  const CWD = "/tmp/pi-extensions-test";

  it.each([
    [{ name: "read", args: { path: `${CWD}/src/stats.py` } }, "Reading src/stats.py"],
    [{ name: "edit", args: { path: "src/stats.py" } }, "Editing src/stats.py"],
    [{ name: "write", args: { path: `${HOME}/notes.md` } }, "Writing ~/notes.md"],
    [{ name: "bash", args: { command: "npm test -- --run\necho done" } }, "Running npm test -- --run"],
    [{ name: "powershell", args: { command: "Get-ChildItem" } }, "Running Get-ChildItem"],
    [{ name: "grep", args: { pattern: "TODO" } }, "Searching TODO"],
    [{ name: "find", args: { pattern: "**/*.test.ts" } }, "Finding **/*.test.ts"],
    [{ name: "ls", args: { path: "src" } }, "Listing src"],
    [{ name: "ls", args: {} }, "Listing ."],
    [{ name: "codemode", args: { code: "1" } }, "Running codemode"],
    [{ name: "mcp__notes__search", args: {}, label: "notes/search" }, "Calling notes/search"],
    [{ name: "run_agent", args: { wait: true, agents: [{}, {}] } }, "Waiting for 2 agents"],
    [{ name: "run_agent", args: { wait: true } }, "Waiting for 1 agent"],
    [{ name: "run_agent", args: { agents: [{}] } }, "Running run_agent"],
    [{ name: "custom_tool", args: {} }, "Running custom_tool"],
    [{ name: "read", args: {} }, "Running read"],
  ] as [RunningTool, string][])("names %o as its activity", (tool, activity) => {
    expect(during([tool])).toBe(message(activity, "12s"));
  });

  it("counts several tools running at once", () => {
    expect(
      during([
        { name: "bash", args: { command: "ls" } },
        { name: "read", args: { path: "a.ts" } },
        { name: "grep", args: { pattern: "x" } },
      ]),
    ).toBe(message("Running 3 tools", "12s"));
  });

  it("says Thinking while the model thinks and waits for the model between steps", () => {
    const host = setup();

    host.agentStart();
    host.setPhase("thinking");

    expect(host.workingMessages.at(-1)).toBe(message("Thinking"));

    host.setPhase("toolArgs");

    expect(host.workingMessages.at(-1)).toBe(message(WAITING));
  });

  const npm = { name: "bash", args: { command: "npm test -- --run" } };

  it("keeps the whole line in the 70 columns the host leaves on an 80-column terminal", () => {
    expect(during([npm], 70)).toBe(message("Running npm test -- --run", "12s"));
  });

  it("drops the hint and cuts the activity in 30 columns, keeping the elapsed time", () => {
    expect(during([npm], 30)).toBe("Running npm test -- -... · 12s");
  });

  it("cuts the activity before dropping the hint, down to 12 columns", () => {
    expect(during([npm], 62)).toBe(message("Running npm test -- --run", "12s"));
    expect(during([npm], 61)).toBe(`Running npm test -- -... · 12s${HINT}`);
    expect(during([npm], 49)).toBe(`Running n... · 12s${HINT}`);
    expect(during([npm], 48)).toBe("Running npm test -- --run · 12s");
  });

  it("cuts a path at its start", () => {
    expect(during([{ name: "read", args: { path: "src/very/long/path/session.ts" } }], 26)).toBe(
      "Reading ...ession.ts · 12s",
    );
  });

  it("cuts wide characters by the columns they take", () => {
    const wide = (text: string) => plainTheme.width(text);
    const path = during([{ name: "read", args: { path: "src/資料/設定ファイル.ts" } }], 26) ?? "";
    const command =
      during([{ name: "bash", args: { command: "echo 日本語のテキストを表示する" } }], 26) ?? "";

    expect(path).toBe("Reading ...ァイル.ts · 12s");
    expect(wide(path)).toBeLessThanOrEqual(26);
    expect(command).toBe("Running echo 日本... · 12s");
    expect(wide(command)).toBeLessThanOrEqual(26);
  });

  it("composes the full text when the terminal width is unknown", () => {
    const long = { name: "bash", args: { command: "x".repeat(200) } };

    expect(during([long])).toBe(message(`Running ${"x".repeat(200)}`, "12s"));
  });

  it("writes no ellipsis character after the activity", () => {
    expect(during([npm])).not.toMatch(/…/);
  });
});
