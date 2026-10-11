import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPiHost } from "../../src/adapter/pi-adapter.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const fakeCtx = (mode: string, idle = true) => ({
  mode,
  hasUI: mode === "tui",
  cwd: "/project",
  model: { contextWindow: 200_000 },
  sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/sessions/s1.jsonl" },
  isProjectTrusted: () => true,
  isIdle: () => idle,
  getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
  ui: {
    notify: () => {},
    setStatus: () => {},
    confirm: async () => true,
    theme: { fg: (_t: string, s: string) => s },
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

  const fire = (event: string, ctx: unknown) => {
    handlers.get(event)?.forEach((handler) => {
      handler({}, ctx);
    });
  };

  return { pi: pi as unknown as ExtensionAPI, fire, commands, sent };
};

describe("pi adapter", () => {
  it("forwards session events only in conversational modes", () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { stale: false });
    const seen: string[] = [];

    host.onSessionStart((info) => seen.push(`start ${info.file}`));
    host.onTurnEnd((context) => seen.push(`turn ${context.tokens}/${context.window}`));
    host.onIdle(() => seen.push("idle"));

    fire("session_start", fakeCtx("print"));
    fire("turn_end", fakeCtx("print"));
    fire("agent_settled", fakeCtx("json"));

    expect(seen).toEqual([]);
    expect(host.session()).toBeUndefined();

    fire("session_start", fakeCtx("tui"));
    fire("turn_end", fakeCtx("rpc"));
    fire("agent_settled", fakeCtx("tui"));

    expect(seen).toEqual(["start /sessions/s1.jsonl", "turn 1000/100000", "idle"]);
  });

  it("sends follow-ups while busy and dispatches commands as prompts", () => {
    const { pi, fire, sent } = fakePi();
    const host = createPiHost(pi, { stale: false });

    fire("session_start", fakeCtx("tui", false));
    host.sendUserMessage("write it");
    host.dispatchCommand("session-handoff");

    expect(sent).toEqual([
      { text: "write it", options: { deliverAs: "followUp" } },
      { text: "/session-handoff", options: { expandPromptTemplates: true } },
    ]);
  });

  it("seeds the new session with a displayed message that triggers no turn", async () => {
    const { pi, commands } = fakePi();
    const host = createPiHost(pi, { stale: false });
    const seeded: unknown[] = [];
    const calls: unknown[] = [];

    host.registerCommand("session-handoff", {
      description: "switch",
      run: async (control) => {
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

    await commands.get("session-handoff")?.handler("", ctx);

    expect(calls).toEqual(["/old.jsonl"]);
    expect(seeded).toEqual([
      { message: { customType: "t", content: "hello", display: true }, options: { triggerTurn: false } },
    ]);
  });

  it("subscribes to pi's event bus", () => {
    const { pi } = fakePi();
    const host = createPiHost(pi, { stale: false });
    const received: unknown[] = [];

    host.onEvent("session-limits:busy", (data) => received.push(data));
    pi.events.emit("session-limits:busy", { source: "x", busy: true });

    expect(received).toEqual([{ source: "x", busy: true }]);
  });

  it("reports the session as not idle and runs shutdown handlers once pi shuts it down", () => {
    const { pi, fire } = fakePi();
    const host = createPiHost(pi, { stale: false });
    let shutdowns = 0;

    host.onShutdown(() => {
      shutdowns += 1;
    });

    expect(host.isIdle()).toBe(false);

    fire("session_start", fakeCtx("tui"));

    expect(host.isIdle()).toBe(true);

    fire("session_shutdown", fakeCtx("tui"));

    expect(shutdowns).toBe(1);
    expect(host.isIdle()).toBe(false);
  });
});
