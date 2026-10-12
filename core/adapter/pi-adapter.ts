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
import { createUi, type HostState, liveCtx } from "./pi-ui.ts";
import { sumSessionUsage } from "./usage.ts";

const MCP_BUILTIN_PATH = "builtin:mcp";

export const mcpBuiltinLoaded = (pi: Pick<ExtensionAPI, "getCommands">) =>
  pi.getCommands().some((command) => command.sourceInfo.path === MCP_BUILTIN_PATH);

const sessionInfo = (ctx: ExtensionContext): SessionInfo => ({
  id: ctx.sessionManager.getSessionId(),
  file: ctx.sessionManager.getSessionFile(),
  dir: ctx.sessionManager.getSessionDir(),
  cwd: ctx.cwd,
  agentDir: getAgentDir(),
  projectTrusted: ctx.isProjectTrusted(),
  hasUI: ctx.mode === "tui",
  subscription: ctx.model
    ? ctx.model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(ctx.model)
    : false,
  mode: ctx.mode,
});

const contextOf = (ctx: ExtensionContext): ContextSnapshot => {
  const usage = ctx.getContextUsage();
  const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

  return { tokens: usage?.tokens ?? null, window, percent: usage?.percent ?? null };
};

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

export const createPiHost = (pi: ExtensionAPI, state: HostState): Host => {
  const sections = new Map<string, string>();
  let mainPrompt: string | undefined;
  const startHandlers: ((info: SessionInfo) => void)[] = [];
  const shutdownHandlers: ((reason: ShutdownReason) => void | Promise<void>)[] = [];
  const idleHandlers: (() => void)[] = [];
  const turnEndHandlers: ((context: ContextSnapshot) => void)[] = [];

  const capture = (ctx: ExtensionContext) => {
    state.ctx = ctx;
    state.stale = false;
  };

  pi.on("session_start", (_event, ctx) => {
    capture(ctx);

    const info = sessionInfo(ctx);

    startHandlers.forEach((handler) => {
      handler(info);
    });
  });

  pi.on("session_shutdown", async (event) => {
    await shutdownHandlers.reduce<Promise<void>>(
      (chain, handler) => chain.then(() => handler(event.reason)),
      Promise.resolve(),
    );

    state.stale = true;
  });

  pi.on("before_agent_start", (event, ctx) => {
    capture(ctx);

    if (mainPrompt) {
      replaceMainPrompt(event.systemPromptOptions, mainPrompt);
    }

    sections.forEach((text, name) => {
      event.systemPromptOptions.sections[name] = text;
    });
  });

  pi.on("turn_end", (_event, ctx) => {
    capture(ctx);

    const context = contextOf(ctx);

    turnEndHandlers.forEach((handler) => {
      handler(context);
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
      getArgumentCompletions: spec.complete ? (prefix: string) => spec.complete?.(prefix) ?? null : undefined,
      handler: async (args, ctx) => {
        capture(ctx);
        await spec.run(args, sessionControl(ctx));
      },
    });
  };

  const readEntries = <T>(customType: string): T[] => {
    const ctx = liveCtx(state);

    if (!ctx) {
      return [];
    }

    return ctx.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === customType)
      .map((entry) => (entry as { data: T }).data);
  };

  return {
    ui: createUi(state),
    registerTool,
    registerCommand,
    setPromptSection: (name, text) => {
      sections.set(name, text);
    },
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
    isIdle: () => liveCtx(state)?.isIdle() ?? false,
    contextUsage: () => {
      const ctx = liveCtx(state);

      return ctx ? contextOf(ctx) : undefined;
    },
    sendUserMessage: (text) => {
      const ctx = liveCtx(state);

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
      if (!liveCtx(state)) {
        return;
      }

      pi.sendUserMessage(args ? `/${name} ${args}` : `/${name}`, { expandPromptTemplates: true });
    },
    publish: (channel, data) => {
      if (!liveCtx(state)) {
        return;
      }

      pi.events.emit(channel, data);
    },
    subscribe: (channel, handler) => pi.events.on(channel, handler),
    appendEntry: (customType, data) => {
      if (!liveCtx(state)) {
        return;
      }

      pi.appendEntry(customType, data);
    },
    readEntries,
    sessionUsage: () => sumSessionUsage(liveCtx(state)?.sessionManager.getEntries() ?? []),
    session: () => {
      const ctx = liveCtx(state);

      return ctx ? sessionInfo(ctx) : undefined;
    },
  };
};

export type BootPaths = { root: string; agentDir: string };

export type Boot = (host: Host, runtime: AgentRuntime, paths: BootPaths) => void;

export type PiExtensionOptions = {
  root: string;
  namespace: string;
  childExclude?: readonly string[];
};

export const createPiExtension =
  (boot: Boot, options: PiExtensionOptions): ExtensionFactory =>
  (pi) => {
    if (insideChildSession()) {
      return;
    }

    const state: HostState = { stale: false };
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
