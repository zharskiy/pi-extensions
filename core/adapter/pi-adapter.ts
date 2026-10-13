import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AgentRuntime,
  CommandSpec,
  ContextSnapshot,
  DialogEvent,
  Host,
  Phase,
  PhaseDetail,
  SessionControl,
  SessionInfo,
  ShutdownReason,
  ThemeLike,
  ToolSpec,
} from "./contract.ts";
import { replaceMainPrompt } from "./main-prompt.ts";
import { createPiRuntime } from "./pi-child.ts";
import { footerHost } from "./pi-footer.ts";
import { deltaEvent, detailOf, initialPhase, type PhaseEvent, reducePhase } from "./pi-phase.ts";
import { insideChildSession } from "./pi-scope.ts";
import { toPiTool } from "./pi-tools.ts";
import { createUi, type HostState, padLines, themeLike } from "./pi-ui.ts";
import { readSessionEntries } from "./session-file.ts";
import { contextOf, sumUsage } from "./usage.ts";

export const mcpBuiltinLoaded = (pi: Pick<ExtensionAPI, "getCommands">) =>
  pi.getCommands().some((command) => command.sourceInfo.path === "builtin:mcp");

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

const liveCtx = (state: HostState) => {
  if (!state.ctx) {
    throw new Error("no live pi session: called before session_start or after session_shutdown");
  }

  return state.ctx;
};

export const createPiHost = (pi: ExtensionAPI, state: HostState): Host => {
  let mainPrompt: string | undefined;
  const startHandlers: ((info: SessionInfo, parent?: string) => void)[] = [];
  const shutdownHandlers: ((reason: ShutdownReason) => void | Promise<void>)[] = [];
  const idleHandlers: (() => void)[] = [];
  const turnEndHandlers: ((context: ContextSnapshot) => void)[] = [];
  const compactHandlers: (() => void)[] = [];
  const agentStartHandlers: (() => void)[] = [];
  const phaseHandlers: ((phase: Phase, detail: PhaseDetail) => void)[] = [];
  const dialogHandlers: ((event: DialogEvent) => void)[] = [];
  let phaseState = initialPhase();

  const capture = (ctx: ExtensionContext) => {
    state.ctx = ctx;
  };

  const applyPhase = (event: PhaseEvent) => {
    const next = reducePhase(phaseState, event);

    if (next === phaseState) {
      return;
    }

    phaseState = next;

    const detail = detailOf(next);

    phaseHandlers.forEach((handler) => {
      handler(next.phase, detail);
    });
  };

  pi.on("session_start", (event, ctx) => {
    capture(ctx);

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
  });

  pi.on("agent_start", (_event, ctx) => {
    capture(ctx);

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

    applyPhase({ type: "message_end" });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    capture(ctx);

    if (event.parentToolCallId !== undefined) {
      return;
    }

    applyPhase({ type: "tool_start", id: event.toolCallId, name: event.toolName });
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

  pi.on("agent_settled", (_event, ctx) => {
    capture(ctx);

    idleHandlers.forEach((handler) => {
      handler();
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
    ui: createUi(state),
    registerTool,
    registerCommand,
    setMainPrompt: (text) => {
      mainPrompt = text;
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
    sendUserMessage: (text) => {
      const ctx = state.ctx;

      if (!ctx) {
        return;
      }

      if (ctx.isIdle()) {
        pi.sendUserMessage(text);
        return;
      }

      pi.sendUserMessage(text, { deliverAs: "followUp" });
    },
    sendHiddenMessage: (message, visible) => {
      const ctx = state.ctx;

      if (!ctx) {
        return;
      }

      const custom = {
        customType: message.customType,
        content: message.text,
        display: false,
        details: message.details,
      };

      if (!ctx.isIdle()) {
        pi.sendMessage(custom, { deliverAs: "followUp", triggerTurn: true });
        return;
      }

      pi.sendMessage(custom, { deliverAs: "nextTurn" });
      pi.sendUserMessage(visible);
    },
    registerEntryRenderer: <T>(
      customType: string,
      render: (data: T, state: { expanded: boolean }, theme: ThemeLike) => string[] | undefined,
    ) => {
      pi.registerEntryRenderer<T>(customType, (entry, { expanded }, theme) => {
        const lines = render(entry.data as T, { expanded }, themeLike(theme));

        return lines ? padLines(lines, pi.getSettings().outputPad ?? 1) : undefined;
      });
    },
    dispatchCommand: (name, args) => {
      if (!state.ctx) {
        return;
      }

      pi.sendUserMessage(args ? `/${name} ${args}` : `/${name}`, { expandPromptTemplates: true });
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
    onPhase: (handler) => {
      phaseHandlers.push(handler);
    },
    phase: () =>
      state.ctx
        ? { phase: phaseState.phase, detail: detailOf(phaseState) }
        : { phase: "idle", detail: { running: 0 } },
    onDialog: (handler) => {
      dialogHandlers.push(handler);
    },
    ...footerHost(pi, state),
  };
};

export const createPiExtension =
  (
    boot: (host: Host, runtime: AgentRuntime, paths: { root: string; agentDir: string }) => void,
    options: { root: string; namespace: string; childExclude?: readonly string[] },
  ): ExtensionFactory =>
  (pi) => {
    if (insideChildSession()) {
      return;
    }

    const state: HostState = {};
    const host = createPiHost(pi, state);

    const runtime = createPiRuntime(
      {
        ctx: () => liveCtx(state),
        settings: () => pi.getSettings(),
        thinking: () => pi.getThinkingLevel(),
        skillFiles: () =>
          pi
            .getCommands()
            .filter((command) => command.source === "skill")
            .map((command) => ({ name: command.name.replace(/^skill:/, ""), path: command.sourceInfo.path })),
        activeTools: () => {
          const active = new Set(pi.getActiveTools());

          return pi
            .getAllTools()
            .filter((tool) => active.has(tool.name))
            .map((tool) => ({ name: tool.name, path: tool.sourceInfo.path }));
        },
        mcpDisabled: () => !mcpBuiltinLoaded(pi),
      },
      { namespace: options.namespace, exclude: options.childExclude ?? [] },
    );

    boot(host, runtime, { root: options.root, agentDir: getAgentDir() });
  };
