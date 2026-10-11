import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionFactory,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ContextSnapshot, Host, SessionControl, SessionInfo } from "./contract.ts";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

type HostState = { ctx?: ExtensionContext; stale: boolean };

const isConversation = (ctx: ExtensionContext) => ctx.mode === "tui" || ctx.mode === "rpc";

const liveCtx = (state: HostState) => (state.stale ? undefined : state.ctx);

const sessionInfo = (ctx: ExtensionContext): SessionInfo => ({
  id: ctx.sessionManager.getSessionId(),
  file: ctx.sessionManager.getSessionFile(),
  cwd: ctx.cwd,
  agentDir: getAgentDir(),
  projectTrusted: ctx.isProjectTrusted(),
});

const contextOf = (ctx: ExtensionContext): ContextSnapshot => {
  const usage = ctx.getContextUsage();

  return { tokens: usage?.tokens ?? null, window: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0 };
};

const sessionControl = (ctx: ExtensionCommandContext): SessionControl => ({
  newSession: async ({ parentSession, seed }) => {
    const result = await ctx.newSession({
      parentSession,
      withSession: async (fresh) => {
        await fresh.sendMessage(
          { customType: seed.customType, content: seed.text, display: true },
          { triggerTurn: false },
        );
      },
    });

    return !result.cancelled;
  },
});

export const createPiHost = (pi: ExtensionAPI, state: HostState): Host => {
  const live = () => {
    const ctx = liveCtx(state);

    return ctx && isConversation(ctx) ? ctx : undefined;
  };

  const capture = (ctx: ExtensionContext) => {
    state.ctx = ctx;
    state.stale = false;
  };

  const startHandlers: ((info: SessionInfo) => void)[] = [];
  const turnEndHandlers: ((context: ContextSnapshot) => void)[] = [];
  const idleHandlers: (() => void)[] = [];
  const shutdownHandlers: (() => void)[] = [];

  const forward = <T>(ctx: ExtensionContext, handlers: ((value: T) => void)[], value: () => T) => {
    capture(ctx);

    if (!isConversation(ctx)) {
      return;
    }

    const current = value();

    handlers.forEach((handler) => {
      handler(current);
    });
  };

  pi.on("session_start", (_event, ctx) => {
    forward(ctx, startHandlers, () => sessionInfo(ctx));
  });

  pi.on("turn_end", (_event, ctx) => {
    forward(ctx, turnEndHandlers, () => contextOf(ctx));
  });

  pi.on("agent_settled", (_event, ctx) => {
    forward<void>(ctx, idleHandlers, () => undefined);
  });

  pi.on("session_shutdown", () => {
    shutdownHandlers.forEach((handler) => {
      handler();
    });

    state.stale = true;
  });

  return {
    notify: (message, level) => {
      live()?.ui.notify(message, level);
    },
    style: (token, text) => live()?.ui.theme.fg(token, text) ?? text,
    setStatus: (key, text) => {
      live()?.ui.setStatus(key, text);
    },
    confirm: async (title, message) => {
      const ctx = live();

      if (!ctx?.hasUI) {
        return false;
      }

      return ctx.ui.confirm(title, message);
    },
    registerCommand: (name, spec) => {
      pi.registerCommand(name, {
        description: spec.description,
        handler: async (_args, ctx) => {
          capture(ctx);

          if (!isConversation(ctx)) {
            return;
          }

          await spec.run(sessionControl(ctx));
        },
      });
    },
    onSessionStart: (handler) => {
      startHandlers.push(handler);
    },
    onTurnEnd: (handler) => {
      turnEndHandlers.push(handler);
    },
    onIdle: (handler) => {
      idleHandlers.push(handler);
    },
    onShutdown: (handler) => {
      shutdownHandlers.push(handler);
    },
    onEvent: (channel, handler) => {
      pi.events.on(channel, handler);
    },
    isIdle: () => live()?.isIdle() ?? false,
    session: () => {
      const ctx = live();

      return ctx ? sessionInfo(ctx) : undefined;
    },
    sendUserMessage: (text) => {
      const ctx = live();

      if (!ctx) {
        return;
      }

      if (ctx.isIdle()) {
        pi.sendUserMessage(text);
        return;
      }

      pi.sendUserMessage(text, { deliverAs: "followUp" });
    },
    dispatchCommand: (name) => {
      if (!live()) {
        return;
      }

      pi.sendUserMessage(`/${name}`, { expandPromptTemplates: true });
    },
  };
};

export type Boot = (host: Host, paths: { packageRoot: string }) => void;

export const createPiExtension =
  (boot: Boot): ExtensionFactory =>
  (pi) => {
    boot(createPiHost(pi, { stale: false }), { packageRoot: PACKAGE_ROOT });
  };
