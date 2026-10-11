import type { Host, RunMode, SessionInfo } from "../../../core/adapter/contract.ts";

const CONVERSATIONAL: ReadonlySet<RunMode> = new Set(["tui", "rpc"]);

export const isConversation = (info: SessionInfo | undefined) =>
  info !== undefined && CONVERSATIONAL.has(info.mode);

export const conversationOnly = (host: Host): Host => {
  const active = () => isConversation(host.session());

  const whenActive =
    <A extends unknown[]>(handler: (...args: A) => void) =>
    (...args: A) => {
      if (active()) {
        handler(...args);
      }
    };

  return {
    ...host,
    onSessionStart: (handler) => {
      host.onSessionStart((info) => {
        if (isConversation(info)) {
          handler(info);
        }
      });
    },
    onTurnEnd: (handler) => {
      host.onTurnEnd(whenActive(handler));
    },
    onIdle: (handler) => {
      host.onIdle(whenActive(handler));
    },
    registerCommand: (name, spec) => {
      host.registerCommand(name, {
        ...spec,
        run: (args, control) => (active() ? spec.run(args, control) : undefined),
      });
    },
    isIdle: () => active() && host.isIdle(),
    session: () => {
      const info = host.session();

      return isConversation(info) ? info : undefined;
    },
  };
};
