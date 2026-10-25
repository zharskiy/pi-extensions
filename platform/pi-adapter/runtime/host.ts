import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { contextHost } from "../context/context-facts.ts";
import { contextOf, sumUsage } from "../context/usage-math.ts";
import { createEditorHooks } from "../editor/editor.ts";
import { replaceMainPrompt } from "../prompt/main-prompt.ts";
import { entryHost } from "../tools/entry-renderers.ts";
import { recordPad } from "../tools/row-component.ts";
import { toPiTool } from "../tools/tool-bridge.ts";
import { toolRowsHost } from "../tools/tool-rows.ts";
import type { ContextSnapshot } from "../types/context.ts";
import type { Host } from "../types/host-capabilities.ts";
import type { CommandSpec } from "../types/messages.ts";
import type {
  AssistantEnd,
  DialogEvent,
  IdleInfo,
  Phase,
  SessionControl,
  SessionInfo,
  ShutdownReason,
} from "../types/session.ts";
import type { AnyToolSpec, ToolSpec } from "../types/tools.ts";
import { createThinkingLabelUi, createUi } from "../ui/create-ui.ts";
import { footerHost } from "../ui/footer.ts";
import { createNotices, syncNotices } from "../ui/notices.ts";
import { type HostState, tuiContext } from "../ui/tui-context.ts";
import { messageText, toolCallCount } from "./message-text.ts";
import { deltaEvent, initialPhase, type PhaseEvent, reducePhase } from "./phase.ts";
import { readSessionEntries } from "./session-file.ts";

const onSubscription = ({ model, modelRegistry }: ExtensionContext) =>
  model !== undefined &&
  modelRegistry.isUsingOAuth(model) &&
  modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true;

const sessionInfo = (ctx: ExtensionContext): SessionInfo => ({
  id: ctx.sessionManager.getSessionId(),
  file: ctx.sessionManager.getSessionFile(),
  cwd: ctx.cwd,
  agentDir: getAgentDir(),
  projectTrusted: ctx.isProjectTrusted(),
  subscription: onSubscription(ctx),
  mode: ctx.mode,
});

const sessionControl = (ctx: ExtensionCommandContext): SessionControl => ({
  newSession: async ({ parentSession, seed }) => {
    const result = await ctx.newSession({
      parentSession,
      withSession: seed
        ? async (fresh) => {
            await fresh.sendMessage(
              { customType: seed.customType, content: seed.text, display: true },
              { triggerTurn: false },
            );
          }
        : undefined,
    });

    return !result.cancelled;
  },
});

export const liveCtx = (state: HostState) => {
  if (!state.ctx) {
    throw new Error("no live pi session: called before session_start or after session_shutdown");
  }

  return state.ctx;
};

type HiddenCustom = { customType: string; content: string; display: false; details: unknown };

const HELD_POLL_MS = 100;

export const createPiHost = (pi: ExtensionAPI, state: HostState): Host => {
  let mainPrompt: string | undefined;
  const startHandlers: ((info: SessionInfo, parent?: string) => void)[] = [];
  const shutdownHandlers: ((reason: ShutdownReason) => void | Promise<void>)[] = [];
  const idleHandlers: ((info: IdleInfo) => void)[] = [];
  const turnEndHandlers: ((context: ContextSnapshot) => void)[] = [];
  const compactHandlers: (() => void)[] = [];
  const agentStartHandlers: (() => void)[] = [];
  const assistantEndHandlers: ((info: AssistantEnd) => void)[] = [];
  const phaseHandlers: ((phase: Phase) => void)[] = [];
  const dialogHandlers: ((event: DialogEvent) => void)[] = [];
  let phaseState = initialPhase();
  let runActive = false;
  const held: HiddenCustom[] = [];
  let heldTimer: ReturnType<typeof setTimeout> | undefined;
  const editor = createEditorHooks(() => tuiContext(state));
  const notices = createNotices(state);
  const sections = new Map<string, string>();
  const toolRows = toolRowsHost(pi);
  const thinkingLabel = createThinkingLabelUi(() => tuiContext(state));

  const capture = (ctx: ExtensionContext) => {
    state.ctx = ctx;
  };

  const applyPhase = (event: PhaseEvent) => {
    const next = reducePhase(phaseState, event);
    const changed = next.phase !== phaseState.phase;

    phaseState = next;

    if (!changed) {
      return;
    }

    phaseHandlers.forEach((handler) => {
      handler(next.phase);
    });
  };

  const sendCommand = (text: string) => {
    const ctx = state.ctx;

    if (!ctx) {
      return;
    }

    if (ctx.isIdle()) {
      pi.sendUserMessage(text, { expandPromptTemplates: true });
      return;
    }

    pi.sendUserMessage(text, { expandPromptTemplates: true, deliverAs: "followUp" });
  };

  const startHidden = (customs: HiddenCustom[]) => {
    const [first, ...rest] = customs;

    rest.forEach((custom) => {
      pi.sendMessage(custom, { deliverAs: "nextTurn" });
    });

    if (first) {
      pi.sendMessage(first, { triggerTurn: true });
    }
  };

  const stopHeldPoll = () => {
    clearTimeout(heldTimer);
    heldTimer = undefined;
  };

  const pollHeld = () => {
    heldTimer = setTimeout(deliverHeld, HELD_POLL_MS);
    heldTimer.unref();
  };

  const deliverHeld = () => {
    stopHeldPoll();

    if (!state.ctx || runActive || held.length === 0) {
      return;
    }

    if (!state.ctx.isIdle()) {
      pollHeld();
      return;
    }

    startHidden(held.splice(0));
  };

  pi.on("session_start", (event, ctx) => {
    capture(ctx);
    editor.sync(event.reason);

    const tui = tuiContext(state);

    if (tui) {
      syncNotices(tui);
      recordPad(pi.getSettings().outputPad === 0 ? 0 : 1);
    }

    const info = sessionInfo(ctx);
    const created = event.reason === "new" || event.reason === "fork";
    const parent = created ? ctx.sessionManager.getHeader()?.parentSession : undefined;

    startHandlers.forEach((handler) => {
      handler(info, parent);
    });
  });

  pi.on("session_shutdown", async (event) => {
    const errors: unknown[] = [];

    phaseState = initialPhase();
    runActive = false;
    held.length = 0;
    stopHeldPoll();

    await shutdownHandlers.reduce<Promise<void>>(
      (chain, handler) =>
        chain.then(async () => {
          try {
            await handler(event.reason);
          } catch (error) {
            errors.push(error);
          }
        }),
      Promise.resolve(),
    );

    editor.release();
    notices.release();
    sections.clear();
    toolRows.release();
    thinkingLabel.release();
    state.ctx = undefined;

    if (errors.length > 0) {
      throw errors[0];
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    capture(ctx);

    if (mainPrompt) {
      replaceMainPrompt(event.systemPromptOptions, mainPrompt);
    }

    Object.assign(event.systemPromptOptions.sections, Object.fromEntries(sections));
  });

  pi.on("agent_start", (_event, ctx) => {
    capture(ctx);
    runActive = true;
    stopHeldPoll();
    held.splice(0).forEach((custom) => {
      pi.sendMessage(custom, { deliverAs: "followUp", triggerTurn: true });
    });

    agentStartHandlers.forEach((handler) => {
      handler();
    });

    applyPhase({ type: "agent_start" });
  });

  pi.on("turn_start", (_event, ctx) => {
    capture(ctx);
    applyPhase({ type: "turn_start" });
  });

  pi.on("message_update", (event, ctx) => {
    capture(ctx);

    if (event.message.role !== "assistant") {
      return;
    }

    const delta = deltaEvent(event.assistantMessageEvent.type);

    if (delta) {
      applyPhase(delta);
    }
  });

  pi.on("message_end", (event, ctx) => {
    capture(ctx);

    if (event.message.role !== "assistant") {
      return;
    }

    const info = {
      toolCalls: toolCallCount(event.message.content),
      stopReason: event.message.stopReason,
      text: messageText(event.message.content).trim() !== "",
    };

    assistantEndHandlers.forEach((handler) => {
      handler(info);
    });

    applyPhase({ type: "message_end" });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    capture(ctx);

    if (event.parentToolCallId !== undefined) {
      return;
    }

    applyPhase({ type: "tool_start", id: event.toolCallId });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    capture(ctx);

    if (event.parentToolCallId !== undefined) {
      return;
    }

    applyPhase({ type: "tool_end", id: event.toolCallId });
  });

  pi.on("agent_end", (_event, ctx) => {
    capture(ctx);
    applyPhase({ type: "agent_end" });
  });

  pi.on("turn_end", (_event, ctx) => {
    capture(ctx);

    const context = contextOf(ctx);

    turnEndHandlers.forEach((handler) => {
      handler(context);
    });
  });

  pi.on("session_compact", (_event, ctx) => {
    capture(ctx);

    compactHandlers.forEach((handler) => {
      handler();
    });
  });

  pi.on("agent_settled", (event, ctx) => {
    capture(ctx);
    runActive = false;
    const info: IdleInfo = { aborted: event.aborted === true };

    idleHandlers.forEach((handler) => {
      handler(info);
    });

    applyPhase({ type: "agent_settled" });
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    capture(ctx);

    dialogHandlers.forEach((handler) => {
      handler({ phase: "start", kind: event.kind, title: event.title });
    });
  });

  pi.on("ui_prompt_end", (event, ctx) => {
    capture(ctx);

    dialogHandlers.forEach((handler) => {
      handler({ phase: "end", kind: event.kind, title: event.title });
    });
  });

  const registerTool = <P, D>(spec: ToolSpec<P, D>) => {
    state.tools.set(spec.name, spec as AnyToolSpec);
    pi.registerTool(toPiTool(spec, capture));
  };

  const registerCommand = (name: string, spec: CommandSpec) => {
    pi.registerCommand(name, {
      description: spec.description,
      getArgumentCompletions: spec.complete,
      handler: async (args, ctx) => {
        capture(ctx);
        await spec.run(args, sessionControl(ctx));
      },
    });
  };

  const entriesOf = (file: string | undefined): unknown[] =>
    file ? readSessionEntries(file) : liveCtx(state).sessionManager.getEntries();

  const readEntries = <T>(customType: string, file?: string): T[] =>
    (entriesOf(file) as { type: string; customType?: string; data?: T }[])
      .filter((entry) => entry.type === "custom" && entry.customType === customType)
      .map((entry) => entry.data as T);

  return {
    ui: createUi(state, process.stdout, process.env, editor, notices, thinkingLabel),
    registerTool,
    registerCommand,
    setMainPrompt: (text) => {
      mainPrompt = text;
    },
    setPromptSection: (name, text) => {
      if (text === undefined) {
        sections.delete(name);
        return;
      }

      sections.set(name, text);
    },
    onSessionStart: (handler) => {
      startHandlers.push(handler);
    },
    onSessionShutdown: (handler) => {
      shutdownHandlers.push(handler);
    },
    onIdle: (handler) => {
      idleHandlers.push(handler);
    },
    onTurnEnd: (handler) => {
      turnEndHandlers.push(handler);
    },
    onCompact: (handler) => {
      compactHandlers.push(handler);
    },
    isIdle: () => state.ctx?.isIdle() ?? false,
    sendHiddenMessage: (message) => {
      const ctx = state.ctx;

      if (!ctx) {
        return;
      }

      const custom: HiddenCustom = {
        customType: message.customType,
        content: message.text,
        display: false,
        details: message.details,
      };

      if (runActive) {
        pi.sendMessage(custom, { deliverAs: "followUp", triggerTurn: true });
        return;
      }

      held.push(custom);

      if (ctx.isIdle()) {
        queueMicrotask(deliverHeld);
        return;
      }

      if (!heldTimer) {
        pollHeld();
      }
    },
    dispatchCommand: (name, args) => {
      sendCommand(args ? `/${name} ${args}` : `/${name}`);
    },
    publish: (channel, data) => {
      if (!state.ctx) {
        return;
      }

      pi.events.emit(channel, data);
    },
    subscribe: (channel, handler) => pi.events.on(channel, handler),
    appendEntry: (customType, data) => {
      if (!state.ctx) {
        return;
      }

      pi.appendEntry(customType, data);
    },
    readEntries,
    sessionUsage: (file) => sumUsage(entriesOf(file)),
    session: () => sessionInfo(liveCtx(state)),
    onAgentStart: (handler) => {
      agentStartHandlers.push(handler);
    },
    onAssistantEnd: (handler) => {
      assistantEndHandlers.push(handler);
    },
    onPhase: (handler) => {
      phaseHandlers.push(handler);
    },
    onDialog: (handler) => {
      dialogHandlers.push(handler);
    },
    ...footerHost(pi, state),
    ...contextHost(pi, state),
    ...entryHost(pi),
    registerToolRows: toolRows.registerToolRows,
  };
};
