import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
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

  return { pi: pi as unknown as ExtensionAPI, fire, commands, sent };
};

describe("pi adapter", () => {
  it("forwards session start, turn end and idle with the run mode", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const seen: string[] = [];

    host.onSessionStart((info) => seen.push(`start ${info.file} ${info.mode}`));
    host.onTurnEnd((context) => seen.push(`turn ${context.tokens}/${context.window} ${context.percent}%`));
    host.onIdle(() => seen.push("idle"));

    await fire("session_start", fakeCtx("print"));
    await fire("turn_end", fakeCtx("rpc"));
    await fire("agent_settled", fakeCtx("tui"));

    expect(seen).toEqual(["start /sessions/s1.jsonl print", "turn 1000/100000 1%", "idle"]);
    expect(host.session().mode).toBe("tui");
  });

  it("passes the parent session file to start handlers only for a fork", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});
    const seen: (string | undefined)[] = [];

    host.onSessionStart((_info, forkedFrom) => seen.push(forkedFrom));

    await fire("session_start", fakeCtx("tui"), {
      reason: "fork",
      previousSessionFile: "/sessions/parent.jsonl",
    });
    await fire("session_start", fakeCtx("tui"), {
      reason: "new",
      previousSessionFile: "/sessions/old.jsonl",
    });
    await fire("session_start", fakeCtx("tui"), {
      reason: "resume",
      previousSessionFile: "/sessions/old.jsonl",
    });

    expect(seen).toEqual(["/sessions/parent.jsonl", undefined, undefined]);
  });

  it("throws when asked for the session before session_start", () => {
    const { pi } = fakePi();
    const host = createPiHost(pi, {});

    expect(() => host.session()).toThrow("no live pi session");
  });

  it("takes the subscription flag only from pi's OAuth check", async () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, {});

    await fire("session_start", { ...fakeCtx("tui"), modelRegistry: { isUsingOAuth: () => true } });

    expect(host.session().subscription).toBe(true);

    await fire("session_start", { ...fakeCtx("tui"), model: undefined });

    expect(host.session().subscription).toBe(false);
  });

  it("sends follow-ups while busy and dispatches commands as prompts", async () => {
    const { pi, fire, sent } = fakePi();
    const host = createPiHost(pi, {});

    host.dispatchCommand("ignored");

    await fire("session_start", fakeCtx("tui", false));
    host.sendUserMessage("write it");
    host.dispatchCommand("session-handoff");
    host.dispatchCommand("agents", "a1");

    expect(sent).toEqual([
      { text: "write it", options: { deliverAs: "followUp" } },
      { text: "/session-handoff", options: { expandPromptTemplates: true } },
      { text: "/agents a1", options: { expandPromptTemplates: true } },
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
