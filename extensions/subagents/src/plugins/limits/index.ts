import { effectiveContextLimit } from "../../../core/model/context-limit.ts";
import type { Plugin } from "../../../core/model/plugin.ts";
import { isClosed } from "../../../core/model/types.ts";
import { contextStep, softWarning } from "./context-step.ts";

const LIMITS_SENDER = "pi-subagents";

export const limitsPlugin: Plugin = {
  id: "limits",
  requires: ["agent-registry", "run-agent"],
  enable: ({ bus, settings, services }) => {
    const registry = services.require("registry");
    const runner = services.require("runner");
    const handoff = services.require("handoff");
    const warned = new Set<string>();
    const handoffTurn = new Map<string, number>();

    const send = (id: string, text: string) => runner.route(id, { sender: LIMITS_SENDER, text });

    const offTurn = bus.on("agent:turn", ({ id, context, turns, continuing }) => {
      const record = registry.get(id);

      if (!continuing || !record || isClosed(record.state)) {
        return;
      }

      const limit = effectiveContextLimit(record.contextLimit, context.window, settings.reserveTokens);
      const tokens = context.tokens ?? 0;

      const step = contextStep({
        tokens,
        limit,
        softRatio: settings.softContextRatio,
        hardRatio: settings.hardContextRatio,
        warned: warned.has(id),
        handoffRequested: record.handoffRequested,
        turnsSinceHandoff: turns - (handoffTurn.get(id) ?? turns),
      });

      if (step === "warn") {
        warned.add(id);
        void send(id, softWarning(tokens, limit));
        return;
      }

      if (step === "handoff") {
        warned.add(id);
        handoffTurn.set(id, turns);
        registry.update(id, { handoffRequested: true });
        void send(id, handoff.instruction(record.handoffPath));
        return;
      }

      if (step === "abort") {
        void runner.abort(id, "context hard limit reached before the handoff was finished");
      }
    });

    const offClosed = bus.on("agent:closed", ({ id }) => {
      warned.delete(id);
      handoffTurn.delete(id);
    });

    return () => {
      offTurn();
      offClosed();
    };
  },
};
