import { stripVTControlCharacters } from "node:util";
import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createPiHost, mcpBuiltinLoaded } from "../../adapter/pi-adapter.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const fakeCtx = (mode: string, idle = true) => ({
  mode,
  cwd: "/project",
  model: { contextWindow: 200_000 },
  modelRegistry: { isUsingOAuth: () => false },
  sessionManager: {
    getSessionId: () => "s1",
    getSessionFile: () => "/sessions/s1.jsonl",
  },
  isProjectTrusted: () => true,
  isIdle: () => idle,
  getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
  ui: {
    notify: () => {},
    setStatus: () => {},
    confirm: async () => true,
    theme: { fg: (token: string, text: string) => `<${token}>${text}` },
  },
});

const fakePi = () => {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: { text: string; options?: unknown }[] = [];
  const calls: { call: "sendMessage" | "sendUserMessage"; message: unknown; options?: unknown }[] = [];
  const entryRenderers = new Map<string, EntryRenderer>();
  const settings: { outputPad?: 0 | 1 } = { outputPad: 1 };
  const listeners = new Map<string, ((data: unknown) => void)[]>();

  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, options);
    },
    sendUserMessage: (text: string, options?: unknown) => {
      sent.push({ text, options });
      calls.push({ call: "sendUserMessage", message: text, options });
    },
    sendMessage: (message: unknown, options?: unknown) => {
      calls.push({ call: "sendMessage", message, options });
    },
    registerEntryRenderer: (customType: string, renderer: EntryRenderer) => {
      entryRenderers.set(customType, renderer);
    },
    getSettings: () => settings,
    events: {
      emit: (channel: string, data: unknown) => {
        listeners.get(channel)?.forEach((listener) => {
          listener(data);
        });
      },
      on: (channel: string, listener: (data: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
        return () => {};
      },
    },
  };

  const fire = (event: string, ctx: unknown, payload: unknown = {}) =>
    Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, ctx)));

  return { pi: pi as unknown as ExtensionAPI, fire, commands, sent, calls, entryRenderers, settings };
};

describe("pi adapter", () => {
  it("forwards session start, agent start, turn end and idle with the run mode", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const seen: string[] = [];

    host.onSessionStart((info) => seen.push(`start ${info.file} ${info.mode}`));
    host.onAgentStart(() => seen.push("agent"));
    host.onTurnEnd((context) => seen.push(`turn ${context.tokens}/${context.window} ${context.percent}%`));
    host.onIdle(() => seen.push("idle"));

    await fire("session_start", fakeCtx("print"));
    await fire("agent_start", fakeCtx("tui"));
    await fire("turn_end", fakeCtx("rpc"));
    await fire("agent_settled", fakeCtx("tui"));

    expect(seen).toEqual(["start /sessions/s1.jsonl print", "agent", "turn 1000/100000 1%", "idle"]);
    expect(host.session().mode).toBe("tui");
  });

  it("emits phases from pi events and idle after the idle handlers", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const seen: string[] = [];
    const ctx = fakeCtx("tui");
    const assistant = (type: string) => ({ message: { role: "assistant" }, assistantMessageEvent: { type } });

    host.onIdle(() => seen.push("idle handler"));
    host.onPhase((phase, detail) =>
      seen.push(detail.toolName ? `${phase} ${detail.toolName} ${detail.running}` : phase),
    );

    await fire("session_start", ctx);
    await fire("agent_start", ctx);
    await fire("turn_start", ctx);
    await fire("message_update", ctx, {
      message: { role: "user" },
      assistantMessageEvent: { type: "text_delta" },
    });
    await fire("message_update", ctx, assistant("text_delta"));
    await fire("message_update", ctx, assistant("text_delta"));
    await fire("message_end", ctx, { message: { role: "user" } });
    await fire("message_end", ctx, { message: { role: "assistant" } });
    await fire("tool_execution_start", ctx, { toolCallId: "t1", toolName: "codemode" });
    await fire("tool_execution_start", ctx, { toolCallId: "n1", toolName: "bash", parentToolCallId: "t1" });
    await fire("message_end", ctx, { message: { role: "toolResult" } });
    await fire("tool_execution_end", ctx, { toolCallId: "n1", toolName: "bash", parentToolCallId: "t1" });
    await fire("tool_execution_end", ctx, { toolCallId: "t1", toolName: "codemode" });
    await fire("agent_end", ctx);
    await fire("agent_settled", ctx, { aborted: false });

    expect(seen).toEqual([
      "waiting",
      "writing",
      "waiting",
      "tool codemode 1",
      "waiting",
      "idle handler",
      "idle",
    ]);
    expect(host.phase()).toEqual({ phase: "idle", detail: { running: 0 } });
  });

  it("reports the current phase while a run is active", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const ctx = fakeCtx("tui");

    expect(host.phase()).toEqual({ phase: "idle", detail: { running: 0 } });

    await fire("agent_start", ctx);
    await fire("tool_execution_start", ctx, { toolCallId: "t1", toolName: "bash" });

    expect(host.phase()).toEqual({ phase: "tool", detail: { toolName: "bash", running: 1 } });
  });

  it("resets the phase on shutdown without emitting", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const seen: string[] = [];
    const ctx = fakeCtx("tui");

    host.onPhase((phase) => seen.push(phase));
    host.onSessionShutdown(() => {
      seen.push(`shutdown ${host.phase().phase}`);
    });

    await fire("session_start", ctx);
    await fire("agent_start", ctx);
    await fire("tool_execution_start", ctx, { toolCallId: "t1", toolName: "bash" });
    await fire("session_shutdown", ctx, { reason: "quit" });

    expect(seen).toEqual(["waiting", "tool", "shutdown idle"]);
    expect(host.phase()).toEqual({ phase: "idle", detail: { running: 0 } });
  });

  it("passes the parent session file to start handlers only for a session created from another one", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const seen: (string | undefined)[] = [];
    const withHeader = (parentSession?: string) => {
      const ctx = fakeCtx("tui");

      return { ...ctx, sessionManager: { ...ctx.sessionManager, getHeader: () => ({ parentSession }) } };
    };

    host.onSessionStart((_info, parent) => seen.push(parent));

    await fire("session_start", withHeader("/sessions/forked.jsonl"), { reason: "fork" });
    await fire("session_start", withHeader("/sessions/handoff.jsonl"), { reason: "new" });
    await fire("session_start", withHeader(), { reason: "new", previousSessionFile: "/sessions/old.jsonl" });
    await fire("session_start", withHeader("/sessions/old.jsonl"), { reason: "resume" });
    await fire("session_start", withHeader("/sessions/old.jsonl"), { reason: "startup" });
    await fire("session_start", withHeader("/sessions/old.jsonl"), { reason: "reload" });

    expect(seen).toEqual([
      "/sessions/forked.jsonl",
      "/sessions/handoff.jsonl",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("throws when asked for the session before session_start", () => {
    const { pi } = fakePi();
    const host = createPiHost(pi, {});

    expect(() => host.session()).toThrow("no live pi session");
  });

  it("takes the subscription flag from pi's OAuth check and the provider's subscription mark", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const registry = (isSubscription?: boolean) => ({
      isUsingOAuth: () => true,
      getProvider: () => ({ auth: { oauth: { isSubscription } } }),
    });

    await fire("session_start", { ...fakeCtx("tui"), modelRegistry: registry(true) });

    expect(host.session().subscription).toBe(true);

    await fire("session_start", { ...fakeCtx("tui"), modelRegistry: registry() });

    expect(host.session().subscription).toBe(false);

    await fire("session_start", { ...fakeCtx("tui"), model: undefined });

    expect(host.session().subscription).toBe(false);
  });

  it("queues user messages and commands as follow-ups while busy", async () => {
    // The starting window is covered: pi reports not-idle from submission, before agent_start.
    const { pi, fire, sent } = fakePi();
    const host = createPiHost(pi, {});

    host.dispatchCommand("ignored");

    await fire("session_start", fakeCtx("tui", false));
    host.sendUserMessage("write it");
    host.dispatchCommand("session-handoff");
    host.dispatchCommand("agents", "a1");

    expect(sent).toEqual([
      { text: "write it", options: { deliverAs: "followUp" } },
      { text: "/session-handoff", options: { expandPromptTemplates: true, deliverAs: "followUp" } },
      { text: "/agents a1", options: { expandPromptTemplates: true, deliverAs: "followUp" } },
    ]);
  });

  it("sends user messages and commands as prompts while idle", async () => {
    const { pi, fire, sent } = fakePi();
    const host = createPiHost(pi, {});

    await fire("session_start", fakeCtx("tui", true));
    host.sendUserMessage("write it");
    host.dispatchCommand("skill:review", "src");

    expect(sent).toEqual([
      { text: "write it", options: undefined },
      { text: "/skill:review src", options: { expandPromptTemplates: true } },
    ]);
  });

  it("seeds the new session with a displayed message that triggers no turn", async () => {
    const { pi, commands } = fakePi();
    const host = createPiHost(pi, {});
    const seeded: unknown[] = [];
    const calls: unknown[] = [];
    const received: string[] = [];

    host.registerCommand("session-handoff", {
      description: "switch",
      run: async (args, control) => {
        received.push(args);
        await control.newSession({ parentSession: "/old.jsonl", seed: { customType: "t", text: "hello" } });
      },
    });

    const ctx = {
      ...fakeCtx("tui"),
      newSession: async (options: {
        parentSession?: string;
        withSession: (fresh: unknown) => Promise<void>;
      }) => {
        calls.push(options.parentSession);
        await options.withSession({
          sendMessage: async (message: unknown, options: unknown) => {
            seeded.push({ message, options });
          },
        });

        return { cancelled: false };
      },
    };

    await commands.get("session-handoff")?.handler("now", ctx);

    expect(received).toEqual(["now"]);
    expect(calls).toEqual(["/old.jsonl"]);
    expect(seeded).toEqual([
      { message: { customType: "t", content: "hello", display: true }, options: { triggerTurn: false } },
    ]);
  });

  it("sends a hidden follow-up while a run is active", async () => {
    const { pi, fire, calls } = fakePi();
    const host = createPiHost(pi, {});

    await fire("session_start", fakeCtx("tui", false));
    await fire("agent_start", fakeCtx("tui", false));

    host.sendHiddenMessage(
      { customType: "wake", text: "results", details: { batch: 1 } },
      "↳ 1 agent finished",
    );

    expect(calls).toEqual([
      {
        call: "sendMessage",
        message: { customType: "wake", content: "results", display: false, details: { batch: 1 } },
        options: { deliverAs: "followUp", triggerTurn: true },
      },
    ]);
  });

  it("parks a hidden next-turn message and starts the turn with the visible line when idle", async () => {
    const { pi, fire, calls } = fakePi();
    const host = createPiHost(pi, {});

    await fire("session_start", fakeCtx("tui", true));

    host.sendHiddenMessage({ customType: "wake", text: "results" }, "↳ 2 agents finished");

    expect(calls).toEqual([
      {
        call: "sendMessage",
        message: { customType: "wake", content: "results", display: false, details: undefined },
        options: { deliverAs: "nextTurn" },
      },
      { call: "sendUserMessage", message: "↳ 2 agents finished", options: undefined },
    ]);
  });

  it("holds a hidden message while pi is busy without a run and delivers it the idle way once idle", async () => {
    vi.useFakeTimers();

    try {
      const { pi, fire, calls } = fakePi();
      const host = createPiHost(pi, {});
      let idle = false;
      const ctx = { ...fakeCtx("tui"), isIdle: () => idle };

      await fire("session_start", ctx);

      host.sendHiddenMessage({ customType: "wake", text: "compacting" }, "↳ 1 agent finished");
      await vi.advanceTimersByTimeAsync(500);

      expect(calls).toEqual([]);

      idle = true;
      await vi.advanceTimersByTimeAsync(500);

      expect(calls).toEqual([
        {
          call: "sendMessage",
          message: { customType: "wake", content: "compacting", display: false, details: undefined },
          options: { deliverAs: "nextTurn" },
        },
        { call: "sendUserMessage", message: "↳ 1 agent finished", options: undefined },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a message held before a run starts when that run settles", async () => {
    vi.useFakeTimers();

    try {
      const { pi, fire, calls } = fakePi();
      const host = createPiHost(pi, {});
      let idle = false;
      const ctx = { ...fakeCtx("tui"), isIdle: () => idle };

      await fire("session_start", ctx);

      host.sendHiddenMessage({ customType: "wake", text: "early" }, "↳ 1 agent finished");
      await fire("agent_start", ctx);
      await vi.advanceTimersByTimeAsync(500);

      expect(calls).toEqual([]);

      idle = true;
      await fire("agent_settled", ctx);

      expect(calls.map((call) => [call.call, call.options])).toEqual([
        ["sendMessage", { deliverAs: "nextTurn" }],
        ["sendUserMessage", undefined],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing without a live session", async () => {
    const { pi, fire, calls } = fakePi();
    const host = createPiHost(pi, {});

    host.sendHiddenMessage({ customType: "wake", text: "early" }, "early");

    await fire("session_start", fakeCtx("tui"));
    await fire("session_shutdown", fakeCtx("tui"), { reason: "quit" });

    host.sendHiddenMessage({ customType: "wake", text: "late" }, "late");

    expect(calls).toEqual([]);
  });

  it("renders entry lines indented by outputPad and cut at width - 2 * outputPad, and hides on undefined", () => {
    const { pi, entryRenderers, settings } = fakePi();
    const host = createPiHost(pi, {});
    const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as never;
    const long = "y".repeat(100);

    host.registerEntryRenderer<{ text?: string }>("line", (data, { expanded }) =>
      data.text === undefined ? undefined : [`${data.text}${expanded ? "!" : ""}`],
    );

    const render = (data: unknown, expanded = false) =>
      entryRenderers.get("line")?.(
        { type: "custom", customType: "line", data } as never,
        { expanded },
        theme,
      );

    const padded = (render({ text: long })?.render(40) ?? []).map(stripVTControlCharacters);

    settings.outputPad = 0;

    const flush = (render({ text: long })?.render(40) ?? []).map(stripVTControlCharacters);
    const expanded = render({ text: "a" }, true)?.render(40);

    expect(padded).toHaveLength(1);
    expect(padded[0]?.startsWith(" y")).toBe(true);
    expect(visibleWidth(padded[0] ?? "")).toBe(39);
    expect(padded[0]?.endsWith("…")).toBe(true);
    expect(flush[0]?.startsWith("y")).toBe(true);
    expect(visibleWidth(flush[0] ?? "")).toBe(40);
    expect(expanded).toEqual(["a!"]);
    expect(render({})).toBeUndefined();
  });

  it("splits entry lines containing a newline into separately padded lines", () => {
    const { pi, entryRenderers } = fakePi();
    const host = createPiHost(pi, {});
    const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as never;

    host.registerEntryRenderer("multi", () => ["a\nb"]);

    const lines = entryRenderers
      .get("multi")?.({ type: "custom", customType: "multi", data: {} } as never, { expanded: false }, theme)
      ?.render(20);

    expect(lines).toEqual([" a", " b"]);
  });

  it("forwards dialog start and end with kind and title", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const seen: unknown[] = [];
    const ctx = fakeCtx("tui");

    host.onDialog((event) => seen.push(event));

    await fire("session_start", ctx);
    await fire("ui_prompt_start", ctx, {
      type: "ui_prompt_start",
      reason: "ui_prompt",
      kind: "confirm",
      title: "Allow?",
    });
    await fire("ui_prompt_end", ctx, {
      type: "ui_prompt_end",
      reason: "ui_prompt",
      kind: "confirm",
      title: "Allow?",
    });
    await fire("ui_prompt_start", ctx, { type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });

    expect(seen).toEqual([
      { phase: "start", kind: "confirm", title: "Allow?" },
      { phase: "end", kind: "confirm", title: "Allow?" },
      { phase: "start", kind: "custom", title: undefined },
    ]);
  });

  it("subscribes to pi's event bus and publishes only with a live session", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const received: unknown[] = [];

    host.subscribe("channel", (data) => received.push(data));
    host.publish("channel", "before start");
    pi.events.emit("channel", { source: "x", busy: true });

    await fire("session_start", fakeCtx("tui"));
    host.publish("channel", "live");

    expect(received).toEqual([{ source: "x", busy: true }, "live"]);
  });

  it("styles text with pi's theme and falls back to plain text without a session", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});

    expect(host.ui.style("warning", "ctx")).toBe("ctx");

    await fire("session_start", fakeCtx("tui"));

    expect(host.ui.style("warning", "ctx")).toBe("<warning>ctx");
  });

  it("is not idle without a live session and runs shutdown handlers before the session goes stale", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const seen: unknown[] = [];

    host.onSessionShutdown((reason) => {
      seen.push(reason, host.session().id);
    });

    expect(host.isIdle()).toBe(false);

    await fire("session_start", fakeCtx("tui"));

    expect(host.isIdle()).toBe(true);

    await fire("session_shutdown", fakeCtx("tui"), { reason: "new" });

    expect(seen).toEqual(["new", "s1"]);
    expect(host.isIdle()).toBe(false);
    expect(() => host.session()).toThrow("no live pi session");
  });

  it("runs shutdown handlers one after another in registration order", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const seen: string[] = [];

    host.onSessionShutdown(async () => {
      seen.push("first start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push("first end");
    });

    host.onSessionShutdown(() => {
      seen.push("second");
    });

    await fire("session_start", fakeCtx("tui"));
    await fire("session_shutdown", fakeCtx("tui"), { reason: "quit" });

    expect(seen).toEqual(["first start", "first end", "second"]);
  });

  it("runs every shutdown handler and goes stale even when one throws, then rethrows the error", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const seen: string[] = [];

    host.onSessionShutdown(async () => {
      throw new Error("boom");
    });

    host.onSessionShutdown(() => {
      seen.push("second");
    });

    await fire("session_start", fakeCtx("tui"));

    await expect(fire("session_shutdown", fakeCtx("tui"), { reason: "quit" })).rejects.toThrow("boom");
    expect(seen).toEqual(["second"]);
    expect(() => host.session()).toThrow("no live pi session");
  });
});

describe("main session MCP", () => {
  const commandsFrom = (...paths: string[]) => ({
    getCommands: () =>
      paths.map((path) => ({ name: "mcp", source: "extension", sourceInfo: { path } })) as never,
  });

  it("counts only pi's MCP built-in, not another extension's /mcp command", () => {
    expect(mcpBuiltinLoaded(commandsFrom("/ext/a.ts", "builtin:mcp"))).toBe(true);
    expect(mcpBuiltinLoaded(commandsFrom("/ext/other-mcp/index.ts"))).toBe(false);
    expect(mcpBuiltinLoaded(commandsFrom())).toBe(false);
  });
});
