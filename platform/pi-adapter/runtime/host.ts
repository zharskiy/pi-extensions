import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { contextHost } from "../context/context-facts.ts";
import { contextOf, sumUsage } from "../context/usage-math.ts";
import { createEditorHooks } from "../editor/editor.ts";
import { captureTui } from "../editor/input.ts";
import { replaceMainPrompt } from "../prompt/main-prompt.ts";
import { entryHost } from "../tools/entry-renderers.ts";
import {
  PREVIOUS_SESSION_TYPE,
  previousSessionRenderer,
  showPreviousSession,
} from "../tools/previous-session.ts";
import { recordPad } from "../tools/row-component.ts";
import { toPiTool } from "../tools/tool-bridge.ts";
import { toolRowsHost } from "../tools/tool-rows.ts";
import type { ContextSnapshot } from "../types/context.ts";
import type { Host } from "../types/host-capabilities.ts";
import type { CommandSpec, CustomMessage, UserMessage } from "../types/messages.ts";
import { isThinkingLevel } from "../types/model.ts";
import type {
  AssistantEnd,
  DialogEvent,
  IdleInfo,
  Phase,
  SessionControl,
  SessionFill,
  SessionInfo,
  ShutdownReason,
  UserInput,
} from "../types/session.ts";
import type { AnyToolSpec, ToolSpec } from "../types/tools.ts";
import { createThinkingLabelUi, createUi } from "../ui/create-ui.ts";
import { footerHost } from "../ui/footer.ts";
import { createNotices, syncNotices } from "../ui/notices.ts";
import { type HostState, tuiContext } from "../ui/tui-context.ts";
import { writeDefaultModel, writeDefaultThinkingLevel } from "./default-model.ts";
import { dropFollowUps, followUpsQueued, queueFollowUp, takeFollowUp } from "./follow-ups.ts";
import { globalRecord } from "./global-record.ts";
import {
  claimKeptSelection,
  forgetSessionSelection,
  keepSelection,
  releaseRestoredSelection,
  restoredSelection,
  restoreSelection,
} from "./kept-selection.ts";
import { toolCallCount } from "./message-text.ts";
import { deltaEvent, initialPhase, type PhaseEvent, reducePhase } from "./phase.ts";
import { readSessionEntries } from "./session-file.ts";

const onSubscription = ({ model, modelRegistry }: ExtensionContext) =>
  model !== undefined &&
  modelRegistry.isUsingOAuth(model) &&
  modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true;

const sessionInfo = (ctx: ExtensionContext, created: boolean): SessionInfo => ({
  id: ctx.sessionManager.getSessionId(),
  file: ctx.sessionManager.getSessionFile(),
  parentSession: ctx.sessionManager.getHeader()?.parentSession,
  created,
  cwd: ctx.cwd,
  agentDir: getAgentDir(),
  projectTrusted: ctx.isProjectTrusted(),
  subscription: onSubscription(ctx),
  mode: ctx.mode,
});

type NewSessionRequest = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;

type FreshSession = Parameters<NonNullable<NewSessionRequest["withSession"]>>[0];

const warnOf = (fresh: FreshSession, lead: string) => (error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error);

  fresh.ui.notify(`${lead}: ${reason}`, "warning");
};

const sendFollowUps = (fresh: FreshSession, followUps: UserMessage[]) => {
  void followUps
    .reduce<Promise<void>>(
      (chain, { text, images }) =>
        chain.then(() =>
          fresh.sendUserMessage(
            [{ type: "text", text }, ...images.map((image) => ({ type: "image" as const, ...image }))],
            { deliverAs: "followUp", expandPromptTemplates: true },
          ),
        ),
      Promise.resolve(),
    )
    .catch(warnOf(fresh, "A message kept for the new session could not be sent"));
};

const fillSession = async (
  fresh: FreshSession,
  { seed, followUps = [], editorText }: SessionFill,
  run: boolean,
) => {
  if (editorText) {
    fresh.ui.setEditorText(editorText);
  }

  const sent = fresh.sendMessage(
    { customType: seed.customType, content: seed.text, display: true, details: seed.details },
    { triggerTurn: run },
  );

  if (run) {
    void sent.catch(warnOf(fresh, "The new session could not continue the handoff"));
  } else {
    await sent;
  }

  sendFollowUps(fresh, followUps);
};

const sessionControl = (pi: ExtensionAPI, ctx: ExtensionCommandContext): SessionControl => ({
  newSession: async ({ parentSession, keepSelection: keep, showPrevious, continueWithSeed, fill }) => {
    const kept = keep ? keepSelection(pi.getThinkingLevel(), ctx) : undefined;
    const label = typeof showPrevious === "object" ? showPrevious.label : undefined;
    const shown = showPrevious ? showPreviousSession(ctx, label) : undefined;

    const setup = async (sessionManager: SessionManager) => {
      await kept?.(sessionManager);
      await shown?.(sessionManager);
    };

    const result = await ctx.newSession({
      parentSession,
      setup: kept || shown ? setup : undefined,
      withSession: (fresh) => fillSession(fresh, fill(), continueWithSeed === true),
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

type HeldCustom = { customType: string; content: string; display: boolean; details: unknown };

const HELD_POLL_MS = 100;

const sessionOf = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();

const hostStates = () => globalRecord<Set<HostState>>("host-states", () => new Set());

const modelRef = (model: ExtensionContext["model"]) => model && `${model.provider}/${model.id}`;

export const createPiHost = (pi: ExtensionAPI, state: HostState): Host => {
  let mainPrompt: string | undefined;
  const startHandlers: ((info: SessionInfo) => void)[] = [];
  const shutdownHandlers: ((reason: ShutdownReason) => void | Promise<void>)[] = [];
  const idleHandlers: ((info: IdleInfo) => void)[] = [];
  const turnEndHandlers: ((context: ContextSnapshot) => void)[] = [];
  const compactHandlers: (() => void)[] = [];
  const inputHandlers: ((input: UserInput) => boolean)[] = [];
  const agentStartHandlers: (() => void)[] = [];
  const assistantStartHandlers: (() => void)[] = [];
  const assistantEndHandlers: ((info: AssistantEnd) => void)[] = [];
  const phaseHandlers: ((phase: Phase) => void)[] = [];
  const dialogHandlers: ((event: DialogEvent) => void)[] = [];
  const modelSelectHandlers: ((ref: string) => void | Promise<void>)[] = [];
  const thinkingSelectHandlers: ((level: string) => void | Promise<void>)[] = [];
  let phaseState = initialPhase();
  let runActive = false;
  const held: HeldCustom[] = [];
  let heldTimer: ReturnType<typeof setTimeout> | undefined;
  const editor = createEditorHooks(() => tuiContext(state));
  const notices = createNotices(state);
  const sections = new Map<string, string>();
  const toolRows = toolRowsHost(pi);
  const entries = entryHost(pi);
  const thinkingLabel = createThinkingLabelUi(() => tuiContext(state));
  let created = false;
  let previousTui: ReturnType<typeof captureTui>;
  let currentModel: string | undefined;

  hostStates().add(state);

  const previous = previousSessionRenderer({
    cwd: () => state.ctx?.cwd ?? process.cwd(),
    tools: () => [...hostStates()].flatMap((host) => [...host.tools.values()]),
    requestRender: () => {
      const ctx = tuiContext(state);

      if (ctx) {
        previousTui ??= captureTui(ctx);
        previousTui?.requestRender();
      }
    },
  });

  entries.registerEntryRenderer(PREVIOUS_SESSION_TYPE, previous.render, {
    flush: true,
    previousSession: false,
    invalidate: previous.invalidate,
  });

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

  const followUp = (ctx: ExtensionContext, custom: HeldCustom) => {
    queueFollowUp(sessionOf(ctx), custom.customType);
    pi.sendMessage(custom, { deliverAs: "followUp", triggerTurn: true });
  };

  const endsRun = (ctx: ExtensionContext, stopReason: string, toolCalls: number) =>
    toolCalls === 0 && stopReason === "stop" && !ctx.hasPendingMessages() && !followUpsQueued(sessionOf(ctx));

  const startHeld = (customs: HeldCustom[]) => {
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

    startHeld(held.splice(0));
  };

  const deliver = (message: CustomMessage, display: boolean) => {
    const ctx = state.ctx;

    if (!ctx) {
      return;
    }

    const custom: HeldCustom = {
      customType: message.customType,
      content: message.text,
      display,
      details: message.details,
    };

    if (runActive) {
      followUp(ctx, custom);
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
  };

  pi.on("session_start", async (event, ctx) => {
    capture(ctx);
    editor.sync(event.reason);

    const kept = event.reason === "new" ? claimKeptSelection(ctx) : undefined;

    if (kept) {
      await restoreSelection(pi, ctx, kept);
    }

    const tui = tuiContext(state);

    if (tui) {
      syncNotices(tui);
      recordPad(pi.getSettings().outputPad === 0 ? 0 : 1);
    }

    created = event.reason === "new" || event.reason === "fork";
    currentModel = modelRef(ctx.model);

    const info = sessionInfo(ctx, created);

    startHandlers.forEach((handler) => {
      handler(info);
    });
  });

  pi.on("session_shutdown", async (event) => {
    const errors: unknown[] = [];

    phaseState = initialPhase();
    runActive = false;
    held.length = 0;
    currentModel = undefined;
    stopHeldPoll();

    if (state.ctx) {
      dropFollowUps(sessionOf(state.ctx));
      forgetSessionSelection(state.ctx);
    }

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
    entries.release();
    thinkingLabel.release();
    hostStates().delete(state);
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
      followUp(ctx, custom);
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

  pi.on("message_start", (event, ctx) => {
    capture(ctx);

    if (event.message.role === "custom") {
      takeFollowUp(sessionOf(ctx), event.message, event.message.customType);
      return;
    }

    if (event.message.role !== "assistant") {
      return;
    }

    assistantStartHandlers.forEach((handler) => {
      handler();
    });
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

    const toolCalls = toolCallCount(event.message.content);
    const info = { toolCalls, final: endsRun(ctx, event.message.stopReason, toolCalls) };

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

  pi.on("input", (event, ctx) => {
    capture(ctx);

    const input: UserInput = {
      text: event.text,
      images: (event.images ?? []).map(({ data, mimeType }) => ({ data, mimeType })),
      source: event.source,
    };

    return inputHandlers.some((handler) => handler(input)) ? { action: "handled" } : { action: "continue" };
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
    dropFollowUps(sessionOf(ctx));
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

  pi.on("model_select", async (event, ctx) => {
    capture(ctx);

    currentModel = modelRef(event.model);

    if (event.source === "restore") {
      return;
    }

    const ref = `${event.model.provider}/${event.model.id}`;
    const restored = restoredSelection(ctx);

    if (restored?.model === ref) {
      return;
    }

    if (restored) {
      releaseRestoredSelection(ctx);
    }

    await Promise.all(modelSelectHandlers.map((handler) => handler(ref)));
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    capture(ctx);

    const restored = restoredSelection(ctx);

    if (restored && restored.model === modelRef(ctx.model)) {
      const chosen =
        restored.applied && event.level !== restored.thinking && event.level === pi.getThinkingLevel();

      if (!chosen) {
        return;
      }

      releaseRestoredSelection(ctx);
    }

    const switching = currentModel !== undefined && modelRef(ctx.model) !== currentModel;
    const superseded = event.level !== pi.getThinkingLevel();

    if (switching || superseded) {
      return;
    }

    await Promise.all(thinkingSelectHandlers.map((handler) => handler(event.level)));
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
        await spec.run(args, sessionControl(pi, ctx));
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
    onInput: (handler) => {
      inputHandlers.push(handler);
    },
    isIdle: () => state.ctx?.isIdle() ?? false,
    sendHiddenMessage: (message) => {
      deliver(message, false);
    },
    sendMessage: (message) => {
      deliver(message, true);
    },
    dispatchCommand: (name) => {
      sendCommand(`/${name}`);
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
    session: () => sessionInfo(liveCtx(state), created),
    onAgentStart: (handler) => {
      agentStartHandlers.push(handler);
    },
    onAssistantStart: (handler) => {
      assistantStartHandlers.push(handler);
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
    onModelSelect: (handler) => {
      modelSelectHandlers.push(handler);
    },
    saveDefaultModel: (ref) => writeDefaultModel(liveCtx(state), ref),
    onThinkingSelect: (handler) => {
      thinkingSelectHandlers.push(handler);
    },
    setThinkingLevel: (level) => {
      if (isThinkingLevel(level)) {
        pi.setThinkingLevel(level);
      }
    },
    saveDefaultThinkingLevel: async (level) =>
      isThinkingLevel(level)
        ? writeDefaultThinkingLevel(liveCtx(state), level)
        : `${level} is not a thinking level`,
    ...footerHost(pi, state),
    ...contextHost(pi, state),
    registerEntryRenderer: entries.registerEntryRenderer,
    registerMessageRenderer: entries.registerMessageRenderer,
    registerToolRows: toolRows.registerToolRows,
  };
};
