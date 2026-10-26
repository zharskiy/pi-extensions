import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initPiRenderTheme } from "../../../test/framework/pi/index.ts";
import { createPiExtension, mcpBuiltinLoaded } from "../runtime/extension.ts";
import { createPiHost } from "../runtime/host.ts";
import { sharedPad } from "../tools/row-component.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const fakeCtx = (mode: string, idle = true) => ({
  mode,
  cwd: "/project",
  model: { contextWindow: 200_000 },
  modelRegistry: { isUsingOAuth: () => false },
  sessionManager: {
    getSessionId: () => "s1",
    getSessionFile: () => "/sessions/s1.jsonl",
    getHeader: () => undefined,
    buildContextEntries: () => [],
  },
  isProjectTrusted: () => true,
  isIdle: () => idle,
  getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
  ui: {
    notify: () => {},
    setStatus: () => {},
    confirm: async () => true,
    getEditorComponent: () => undefined,
    setWidget: () => {},
    theme: { fg: (token: string, text: string) => `<${token}>${text}` },
  },
});

const fakePi = () => {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: { text: string; options?: unknown }[] = [];
  const calls: { call: "sendMessage" | "sendUserMessage"; message: unknown; options?: unknown }[] = [];
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const renderers: string[] = [];

  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, options);
    },
    registerTool: () => {},
    sendUserMessage: (text: string, options?: unknown) => {
      sent.push({ text, options });
      calls.push({ call: "sendUserMessage", message: text, options });
    },
    sendMessage: (message: unknown, options?: unknown) => {
      calls.push({ call: "sendMessage", message, options });
    },
    getSettings: () => ({}),
    getCommands: () => [],
    registerEntryRenderer: (customType: string) => {
      renderers.push(customType);
    },
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

  const fireInOrder = (event: string, ctx: unknown, payload: unknown = {}) =>
    (handlers.get(event) ?? []).reduce<Promise<unknown>>(
      (chain, handler) => chain.then(() => handler(payload, ctx)),
      Promise.resolve(),
    );

  return { pi: pi as unknown as ExtensionAPI, fire, fireInOrder, commands, sent, calls, renderers };
};

describe("pi adapter", () => {
  it("forwards session start, agent start, turn end and idle with the run mode", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
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

  it("takes the output pad for entries from pi's settings at a tui session start", async () => {
    const { pi, fire } = fakePi();
    const settings: { outputPad?: number } = { outputPad: 0 };

    createPiHost({ ...pi, getSettings: () => settings } as never, { tools: new Map() });

    await fire("session_start", fakeCtx("tui"));

    expect(sharedPad()).toBe(0);

    settings.outputPad = undefined;
    await fire("session_start", fakeCtx("tui"));

    expect(sharedPad()).toBe(1);
  });

  it("reserves the notice slot under the editor at a tui session start, before the extension's handlers", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
    const widgets: string[] = [];
    const ctxOf = (mode: string) => {
      const ctx = fakeCtx(mode);

      return {
        ...ctx,
        ui: {
          ...ctx.ui,
          setWidget: (key: string, _factory: unknown, options?: { placement?: string }) =>
            widgets.push(`${key} ${options?.placement}`),
        },
      };
    };

    host.onSessionStart(() => widgets.push("start handler"));

    await fire("session_start", ctxOf("rpc"));

    expect(widgets).toEqual(["start handler"]);

    await fire("session_start", ctxOf("tui"));

    expect(widgets).toEqual(["start handler", "pi-notices belowEditor", "start handler"]);
  });

  it("tells idle handlers whether the settled run was aborted", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
    const seen: boolean[] = [];

    host.onIdle(({ aborted }) => seen.push(aborted));

    await fire("session_start", fakeCtx("tui"));
    await fire("agent_settled", fakeCtx("tui"), { aborted: true });
    await fire("agent_settled", fakeCtx("tui"), { aborted: false });
    await fire("agent_settled", fakeCtx("tui"));

    expect(seen).toEqual([true, false, false]);
  });

  it("emits phases from pi events and idle after the idle handlers", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
    const seen: string[] = [];
    const ctx = fakeCtx("tui");
    const assistant = (type: string) => ({ message: { role: "assistant" }, assistantMessageEvent: { type } });

    host.onIdle(() => seen.push("idle handler"));
    host.onPhase((phase) => seen.push(phase));

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

    expect(seen).toEqual(["waiting", "writing", "waiting", "tool", "waiting", "idle handler", "idle"]);
  });

  it("reports the tool calls and stop reason of an assistant message end, not of other messages", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
    const seen: unknown[] = [];
    const ctx = fakeCtx("tui");

    host.onAssistantEnd((info) => seen.push(info));

    await fire("session_start", ctx);
    await fire("message_end", ctx, { message: { role: "user", content: "hi" } });
    await fire("message_end", ctx, {
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "looking" },
          { type: "toolCall", id: "a", name: "read", arguments: {} },
          { type: "toolCall", id: "b", name: "grep", arguments: {} },
        ],
      },
    });
    await fire("message_end", ctx, {
      message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "hm" }] },
    });
    await fire("message_end", ctx, { message: { role: "toolResult", content: [] } });

    expect(seen).toEqual([
      { toolCalls: 2, stopReason: "toolUse", text: true },
      { toolCalls: 0, stopReason: "stop", text: false },
    ]);
  });

  it("stays in the tool phase until the last parallel tool ends", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
    const seen: string[] = [];
    const ctx = fakeCtx("tui");

    host.onPhase((phase) => seen.push(phase));

    await fire("session_start", ctx);
    await fire("agent_start", ctx);
    await fire("tool_execution_start", ctx, { toolCallId: "a", toolName: "bash" });
    await fire("tool_execution_start", ctx, { toolCallId: "b", toolName: "grep" });
    await fire("tool_execution_end", ctx, { toolCallId: "a", toolName: "bash" });
    await fire("tool_execution_end", ctx, { toolCallId: "b", toolName: "grep" });

    expect(seen).toEqual(["waiting", "tool", "waiting"]);
  });

  it("resets the phase on shutdown without emitting", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
    const seen: string[] = [];
    const ctx = fakeCtx("tui");

    host.onPhase((phase) => seen.push(phase));
    host.onSessionShutdown(() => {
      seen.push("shutdown");
    });

    await fire("session_start", ctx);
    await fire("agent_start", ctx);
    await fire("session_shutdown", ctx, { reason: "quit" });
    await fire("session_start", ctx);
    await fire("agent_start", ctx);

    expect(seen).toEqual(["waiting", "shutdown", "waiting"]);
  });

  it("exposes the header's parent session on the session info for every start reason", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
    const seen: (string | undefined)[] = [];
    const ctx = fakeCtx("tui");

    host.onSessionStart((info) => seen.push(info.parentSession));

    await fire(
      "session_start",
      {
        ...ctx,
        sessionManager: { ...ctx.sessionManager, getHeader: () => ({ parentSession: "/sessions/p.jsonl" }) },
      },
      { reason: "reload" },
    );
    await fire("session_start", ctx, { reason: "new" });

    expect(seen).toEqual(["/sessions/p.jsonl", undefined]);
  });

  it("marks a session created only when pi starts it by new or fork", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
    const seen: [boolean, boolean][] = [];
    const withHeader = (parentSession?: string) => {
      const ctx = fakeCtx("tui");

      return { ...ctx, sessionManager: { ...ctx.sessionManager, getHeader: () => ({ parentSession }) } };
    };

    host.onSessionStart((info) => seen.push([info.created, host.session().created]));

    await fire("session_start", withHeader("/sessions/forked.jsonl"), { reason: "fork" });
    await fire("session_start", withHeader("/sessions/handoff.jsonl"), { reason: "new" });
    await fire("session_start", withHeader(), { reason: "new", previousSessionFile: "/sessions/old.jsonl" });
    await fire("session_start", withHeader("/sessions/old.jsonl"), { reason: "resume" });
    await fire("session_start", withHeader("/sessions/old.jsonl"), { reason: "startup" });
    await fire("session_start", withHeader("/sessions/old.jsonl"), { reason: "reload" });

    expect(seen).toEqual([
      [true, true],
      [true, true],
      [true, true],
      [false, false],
      [false, false],
      [false, false],
    ]);
  });

  it("throws when asked for the session before session_start", () => {
    const { pi } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });

    expect(() => host.session()).toThrow("no live pi session");
  });

  it("takes the subscription flag from pi's OAuth check and the provider's subscription mark", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
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

  it("queues commands as follow-ups while busy", async () => {
    const { pi, fire, sent } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });

    host.dispatchCommand("ignored");

    await fire("session_start", fakeCtx("tui", false));
    host.dispatchCommand("session-handoff");

    expect(sent).toEqual([
      { text: "/session-handoff", options: { expandPromptTemplates: true, deliverAs: "followUp" } },
    ]);
  });

  it("sends commands as prompts while idle", async () => {
    const { pi, fire, sent } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });

    await fire("session_start", fakeCtx("tui", true));
    host.dispatchCommand("skill:review");

    expect(sent).toEqual([{ text: "/skill:review", options: { expandPromptTemplates: true } }]);
  });

  it("seeds the new session with a displayed message that triggers no turn", async () => {
    const { pi, commands } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
    const seeded: unknown[] = [];
    const calls: unknown[] = [];
    const received: string[] = [];

    host.registerCommand("session-handoff", {
      description: "switch",
      run: async (args, control) => {
        received.push(args);
        await control.newSession({
          parentSession: "/old.jsonl",
          seed: { customType: "t", text: "hello", details: { n: 1 } },
        });
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
      {
        message: { customType: "t", content: "hello", display: true, details: { n: 1 } },
        options: { triggerTurn: false },
      },
    ]);
  });

  it("sends a hidden follow-up while a run is active", async () => {
    const { pi, fire, calls } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });

    await fire("session_start", fakeCtx("tui", false));
    await fire("agent_start", fakeCtx("tui", false));

    host.sendHiddenMessage({ customType: "wake", text: "results", details: { batch: 1 } });

    expect(calls).toEqual([
      {
        call: "sendMessage",
        message: { customType: "wake", content: "results", display: false, details: { batch: 1 } },
        options: { deliverAs: "followUp", triggerTurn: true },
      },
    ]);
  });

  it("sends a displayed message during a run as a follow-up that triggers a turn", async () => {
    const { pi, fire, calls } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });

    await fire("session_start", fakeCtx("tui", false));
    await fire("agent_start", fakeCtx("tui", false));

    host.sendMessage({ customType: "req", text: "later", details: { n: 1 } });

    expect(calls).toEqual([
      {
        call: "sendMessage",
        message: { customType: "req", content: "later", display: true, details: { n: 1 } },
        options: { deliverAs: "followUp", triggerTurn: true },
      },
    ]);
  });

  it("starts a run with a displayed message when idle", async () => {
    const { pi, fire, calls } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });

    await fire("session_start", fakeCtx("tui", true));

    host.sendMessage({ customType: "req", text: "now" });
    await Promise.resolve();

    expect(calls).toEqual([
      {
        call: "sendMessage",
        message: { customType: "req", content: "now", display: true, details: undefined },
        options: { triggerTurn: true },
      },
    ]);
  });

  it("starts a run with the hidden message when idle and sends no user message", async () => {
    const { pi, fire, calls } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });

    await fire("session_start", fakeCtx("tui", true));

    host.sendHiddenMessage({ customType: "wake", text: "results" });

    expect(calls).toEqual([]);

    await Promise.resolve();

    expect(calls).toEqual([
      {
        call: "sendMessage",
        message: { customType: "wake", content: "results", display: false, details: undefined },
        options: { triggerTurn: true },
      },
    ]);
  });

  it("starts one run for several held messages, the first one triggering it", async () => {
    vi.useFakeTimers();

    try {
      const { pi, fire, calls } = fakePi();
      const host = createPiHost(pi, { tools: new Map() });
      let idle = false;
      const ctx = { ...fakeCtx("tui"), isIdle: () => idle };

      await fire("session_start", ctx);

      host.sendHiddenMessage({ customType: "wake", text: "first" });
      host.sendHiddenMessage({ customType: "wake", text: "second" });

      idle = true;
      await vi.advanceTimersByTimeAsync(500);

      expect(
        calls.map((call) => [call.call, (call.message as { content: string }).content, call.options]),
      ).toEqual([
        ["sendMessage", "second", { deliverAs: "nextTurn" }],
        ["sendMessage", "first", { triggerTurn: true }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends two hidden messages from one idle pass as one run", async () => {
    const { pi, fire, calls } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });

    await fire("session_start", fakeCtx("tui", true));

    host.sendHiddenMessage({ customType: "wake", text: "first" });
    host.sendHiddenMessage({ customType: "wake", text: "second" });
    await Promise.resolve();

    expect(
      calls.map((call) => [call.call, (call.message as { content: string }).content, call.options]),
    ).toEqual([
      ["sendMessage", "second", { deliverAs: "nextTurn" }],
      ["sendMessage", "first", { triggerTurn: true }],
    ]);
  });

  it("holds a hidden message while pi is busy without a run and delivers it the idle way once idle", async () => {
    vi.useFakeTimers();

    try {
      const { pi, fire, calls } = fakePi();
      const host = createPiHost(pi, { tools: new Map() });
      let idle = false;
      const ctx = { ...fakeCtx("tui"), isIdle: () => idle };

      await fire("session_start", ctx);

      host.sendHiddenMessage({ customType: "wake", text: "compacting" });
      await vi.advanceTimersByTimeAsync(500);

      expect(calls).toEqual([]);

      idle = true;
      await vi.advanceTimersByTimeAsync(500);

      expect(calls).toEqual([
        {
          call: "sendMessage",
          message: { customType: "wake", content: "compacting", display: false, details: undefined },
          options: { triggerTurn: true },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands a message held before a run starts to that run as a follow-up", async () => {
    vi.useFakeTimers();

    try {
      const { pi, fire, calls } = fakePi();
      const host = createPiHost(pi, { tools: new Map() });
      let idle = false;
      const ctx = { ...fakeCtx("tui"), isIdle: () => idle };

      await fire("session_start", ctx);

      host.sendHiddenMessage({ customType: "wake", text: "early" });

      expect(calls).toEqual([]);

      await fire("agent_start", ctx);

      expect(calls).toEqual([
        {
          call: "sendMessage",
          message: { customType: "wake", content: "early", display: false, details: undefined },
          options: { deliverAs: "followUp", triggerTurn: true },
        },
      ]);

      idle = true;
      await fire("agent_settled", ctx);
      await vi.advanceTimersByTimeAsync(500);

      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing without a live session", async () => {
    const { pi, fire, calls } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });

    host.sendHiddenMessage({ customType: "wake", text: "early" });

    await fire("session_start", fakeCtx("tui"));
    await fire("session_shutdown", fakeCtx("tui"), { reason: "quit" });

    host.sendHiddenMessage({ customType: "wake", text: "late" });

    expect(calls).toEqual([]);
  });

  it("forwards dialog start and end with kind and title", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
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
    const host = createPiHost(pi, { tools: new Map() });
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
    const host = createPiHost(pi, { tools: new Map() });

    expect(host.ui.style("warning", "ctx")).toBe("ctx");

    await fire("session_start", fakeCtx("tui"));

    expect(host.ui.style("warning", "ctx")).toBe("<warning>ctx");
    expect(host.ui.style("thinkingHigh", "ctx")).toBe("<thinkingHigh>ctx");
  });

  it("is not idle without a live session and runs shutdown handlers before the session goes stale", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
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

  describe("prompt sections", () => {
    const promptOptions = () => ({
      selectedTools: [],
      hiddenTools: [],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      sections: {} as Record<string, string>,
    });

    const copies = async () => {
      const style = fakePi();
      const agents = fakePi();
      const styleHost = createPiHost(style.pi, { tools: new Map() });
      const agentsHost = createPiHost(agents.pi, { tools: new Map() });

      await style.fire("session_start", fakeCtx("tui"));
      await agents.fire("session_start", fakeCtx("tui"));

      const run = async (...fired: (typeof style)[]) => {
        const options = promptOptions();

        await fired.reduce<Promise<unknown>>(
          (previous, copy) =>
            previous.then(() =>
              copy.fire("before_agent_start", fakeCtx("tui"), { systemPromptOptions: options }),
            ),
          Promise.resolve(),
        );

        return options.sections;
      };

      return { style, agents, styleHost, agentsHost, run };
    };

    it("applies a section to a run without a main prompt", async () => {
      const { style, styleHost, run } = await copies();

      styleHost.setPromptSection("output_style", "Be brief.");

      expect(await run(style)).toEqual({ output_style: "Be brief." });
    });

    it("applies another copy's section alongside a copy's main prompt", async () => {
      const { style, agents, styleHost, agentsHost, run } = await copies();

      styleHost.setPromptSection("output_style", "Be brief.");
      agentsHost.setMainPrompt("# Main");

      const sections = await run(style, agents);

      expect(sections.output_style).toBe("Be brief.");
      expect(sections.tools).toBeDefined();
    });

    it("clears a section set to undefined", async () => {
      const { style, styleHost, run } = await copies();

      styleHost.setPromptSection("output_style", "Be brief.");
      styleHost.setPromptSection("output_style", undefined);

      expect(await run(style)).toEqual({});
    });

    it("drops a copy's own section when that copy shuts down", async () => {
      const { style, styleHost, run } = await copies();

      styleHost.setPromptSection("output_style", "Be brief.");
      await style.fire("session_shutdown", fakeCtx("tui"), { reason: "quit" });

      expect(await run(style)).toEqual({});
    });

    it("keeps a copy's section when another copy shuts down", async () => {
      const { style, agents, styleHost, run } = await copies();

      styleHost.setPromptSection("output_style", "Be brief.");
      await agents.fire("session_shutdown", fakeCtx("tui"), { reason: "quit" });

      expect((await run(style, agents)).output_style).toBe("Be brief.");
    });
  });

  it("registers each entry renderer with pi once", () => {
    const { pi, renderers } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });

    host.registerEntryRenderer("x:entry", () => ["line"]);

    expect(renderers).toEqual(["x:entry"]);
  });

  it("runs shutdown handlers one after another in registration order", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { tools: new Map() });
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
    const host = createPiHost(pi, { tools: new Map() });
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

  it("renders the tools registered on the host in an overlay's transcript", async () => {
    initPiRenderTheme();

    const { pi } = fakePi();
    const shown: string[] = [];
    const ctx = {
      mode: "tui",
      cwd: "/project",
      ui: {
        custom: async (factory: (...args: unknown[]) => unknown) => {
          factory(
            { terminal: { rows: 40 }, mode: "fullscreen", requestRender: () => {} },
            {},
            { matches: () => false },
            () => {},
          );
        },
      },
    } as unknown as ExtensionContext;
    const host = createPiHost(pi, { tools: new Map(), ctx });

    host.registerTool({
      name: "probe",
      label: "Probe",
      description: "probe",
      parameters: { type: "object" },
      execute: async () => ({ text: "" }),
      renderCall: () => "PROBE-CALL",
    });

    await host.ui.openOverlay((api) => {
      const pane = api.createTranscript({ owner: "agent-1" });

      pane.sync([
        {
          kind: "assistant",
          raw: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }],
            stopReason: "toolUse",
            timestamp: 0,
          },
        },
      ]);
      shown.push(stripVTControlCharacters(pane.render(80).join("\n")));

      return { render: () => [], handleKey: () => {} };
    });

    expect(shown[0]).toContain("PROBE-CALL");
  });
});

describe("editor hooks boot order", () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-extensions.editor-hooks")];
  });

  it.each([
    ["left", "\x1b[D"],
    ["down", "\x1b[B"],
  ] as const)(
    "installs an empty-%s hook registered while the extension loads once the session starts",
    async (key, data) => {
      const { pi, fire } = fakePi();
      let factory: ((tui: TUI, theme: EditorTheme, keys: KeybindingsManager) => unknown) | undefined;
      let fired = 0;

      createPiExtension(
        (host) => {
          const hook = key === "left" ? host.ui.onEmptyEditorLeft : host.ui.onEmptyEditorDown;

          hook(() => {
            fired += 1;
          });
        },
        { root: "/ext", namespace: "test" },
      )(pi);

      const ctx = fakeCtx("tui");
      const tuiCtx = {
        ...ctx,
        ui: {
          ...ctx.ui,
          getEditorComponent: () => factory,
          setEditorComponent: (next: typeof factory) => {
            factory = next;
          },
        },
      };

      expect(factory).toBeUndefined();

      await fire("session_start", tuiCtx, { reason: "startup" });

      const tui = { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI;
      const theme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
      const editor = factory?.(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS)) as
        | { handleInput(data: string): void }
        | undefined;

      editor?.handleInput(data);

      expect(editor).toBeDefined();
      expect(fired).toBe(1);

      await fire("session_shutdown", tuiCtx, { reason: "reload" });

      expect(factory).toBeUndefined();
    },
  );
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

describe("skill inventory", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    dirs.splice(0).forEach((dir) => {
      rmSync(dir, { recursive: true, force: true });
    });
  });

  const skillAt = (dir: string, name: string) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody.\n`,
    );
  };

  const bootWith = (options: { skillInventory?: boolean }) => {
    const home = mkdtempSync(join(tmpdir(), "pi-adapter-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-adapter-project-"));
    const { pi, fireInOrder } = fakePi();
    const seenAtStart: string[][] = [];
    const sessionSeen: string[][] = [];
    const loaded = join(cwd, "loaded", "SKILL.md");

    (pi as { getCommands: unknown }).getCommands = () => [
      { name: "skill:loaded-skill", source: "skill", description: "", sourceInfo: { path: loaded } },
      { name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp" } },
    ];
    dirs.push(home, cwd);
    skillAt(join(home, "agent", "skills"), "user-skill");
    skillAt(join(cwd, ".pi", "skills"), "project-skill");
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));

    createPiExtension(
      (host, runtime) => {
        host.onSessionStart(() => {
          seenAtStart.push(runtime.skillNames().toSorted());
          sessionSeen.push(runtime.sessionSkillNames());
        });
      },
      { root: "/ext", namespace: "test", ...options },
    )(pi);

    const start = () =>
      fireInOrder(
        "session_start",
        { ...fakeCtx("tui"), cwd, isProjectTrusted: () => true },
        { reason: "startup" },
      );

    return { start, seenAtStart, sessionSeen };
  };

  it("scans the session's trusted cwd before the start handlers run", async () => {
    const { start, seenAtStart, sessionSeen } = bootWith({ skillInventory: true });

    await start();

    expect(seenAtStart).toEqual([["loaded-skill", "project-skill", "user-skill"]]);
    expect(sessionSeen).toEqual([["loaded-skill"]]);
  });

  it("keeps to the main session's loaded skills otherwise", async () => {
    const { start, seenAtStart, sessionSeen } = bootWith({});

    await start();

    expect(seenAtStart).toEqual([["loaded-skill"]]);
    expect(sessionSeen).toEqual([["loaded-skill"]]);
  });
});
