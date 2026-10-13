import type { Host, RunMode } from "../../../core/adapter/contract.ts";

const CONVERSATIONAL: ReadonlySet<RunMode> = new Set(["tui", "rpc"]);

export const conversationOnly = (host: Host): Host => {
  const active = () => CONVERSATIONAL.has(host.session().mode);

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
      host.onSessionStart((info, parent) => {
        if (CONVERSATIONAL.has(info.mode)) {
          handler(info, parent);
        }
      });
    },
    onTurnEnd: (handler) => {
      host.onTurnEnd(whenActive(handler));
    },
    onIdle: (handler) => {
      host.onIdle(whenActive(handler));
    },
    onCompact: (handler) => {
      host.onCompact(whenActive(handler));
    },
    registerCommand: (name, spec) => {
      host.registerCommand(name, {
        ...spec,
        run: (args, control) => (active() ? spec.run(args, control) : undefined),
      });
    },
  };
};
