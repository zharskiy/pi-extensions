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
  Host,
  SessionControl,
  SessionInfo,
  ShutdownReason,
  ToolSpec,
} from "./contract.ts";
import { replaceMainPrompt } from "./main-prompt.ts";
import { createPiRuntime } from "./pi-child.ts";
import { insideChildSession } from "./pi-scope.ts";
import { toPiTool } from "./pi-tools.ts";
import { createUi, type HostState } from "./pi-ui.ts";
import { readSessionEntries } from "./session-file.ts";
import { contextOf, sumUsage } from "./usage.ts";

export const mcpBuiltinLoaded = (pi: Pick<ExtensionAPI, "getCommands">) =>
  pi.getCommands().some((command) => command.sourceInfo.path === "builtin:mcp");

const sessionInfo = (ctx: ExtensionContext): SessionInfo => ({
  id: ctx.sessionManager.getSessionId(),
  file: ctx.sessionManager.getSessionFile(),
  cwd: ctx.cwd,
  agentDir: getAgentDir(),
  projectTrusted: ctx.isProjectTrusted(),
  subscription: ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false,
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
  const startHandlers: ((info: SessionInfo, forkedFrom?: string) => void)[] = [];
  const shutdownHandlers: ((reason: ShutdownReason) => void | Promise<void>)[] = [];
  const idleHandlers: (() => void)[] = [];
  const turnEndHandlers: ((context: ContextSnapshot) => void)[] = [];
  const compactHandlers: (() => void)[] = [];

  const capture = (ctx: ExtensionContext) => {
    state.ctx = ctx;
  };

  pi.on("session_start", (event, ctx) => {
    capture(ctx);

    const info = sessionInfo(ctx);
    const forkedFrom = event.reason === "fork" ? event.previousSessionFile : undefined;

    startHandlers.forEach((handler) => {
      handler(info, forkedFrom);
    });
  });

  pi.on("session_shutdown", async (event) => {
    const errors: unknown[] = [];

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
