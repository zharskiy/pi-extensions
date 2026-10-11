import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime, CommandSpec, Host, SessionInfo, ShutdownReason, ToolSpec } from "./contract.ts";
import { replaceMainPrompt } from "./main-prompt.ts";
import { createPiRuntime } from "./pi-child.ts";
import { insideChildSession, PACKAGE_ROOT } from "./pi-scope.ts";
import { toPiTool } from "./pi-tools.ts";
import { createUi, type HostState, liveCtx } from "./pi-ui.ts";
import { sumSessionUsage } from "./usage.ts";

export { childSettings, childUiContext, createChildExtension, createPiRuntime } from "./pi-child.ts";
export { insideChildSession, PACKAGE_ROOT };

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
});

export const createPiHost = (pi: ExtensionAPI, state: HostState): Host => {
  const sections = new Map<string, string>();
  let mainPrompt: string | undefined;
  const startHandlers: ((info: SessionInfo) => void)[] = [];
  const shutdownHandlers: ((reason: ShutdownReason) => void | Promise<void>)[] = [];
  const idleHandlers: (() => void)[] = [];

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
    await Promise.all(shutdownHandlers.map((handler) => handler(event.reason)));

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
        await spec.run(args);
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
    isIdle: () => liveCtx(state)?.isIdle() ?? true,
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
    publish: (channel, data) => {
      if (!liveCtx(state)) {
        return;
      }

      pi.events.emit(channel, data);
    },
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

export type BootPaths = { packageRoot: string; agentDir: string };

export type Boot = (host: Host, runtime: AgentRuntime, paths: BootPaths) => void;

export const createPiExtension =
  (boot: Boot): ExtensionFactory =>
  (pi) => {
    if (insideChildSession()) {
      return;
    }

    const state: HostState = { stale: false };
    const host = createPiHost(pi, state);

    const runtime = createPiRuntime({
      ctx: () => liveCtx(state),
      settings: () => pi.getSettings(),
      thinking: () => pi.getThinkingLevel(),
    });

    boot(host, runtime, { packageRoot: PACKAGE_ROOT, agentDir: getAgentDir() });
  };
