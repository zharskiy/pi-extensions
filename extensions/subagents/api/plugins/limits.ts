import { HANDOFF_REQUEST_TYPE, type HandoffRequestDetails } from "../../../../platform/shared/index.ts";
import { softWarning } from "../../core/limits/warning.ts";
import { isClosed } from "../../core/model/agent-record.ts";
import { agentLimit, limitStep } from "../../core/model/context-limit.ts";
import { handoffService } from "../../core/model/handoff.ts";
import type { Plugin } from "../../core/model/plugin.ts";

const LIMITS_SENDER = "pi-subagents";

export const limitsPlugin: Plugin = {
  id: "limits",
  requires: ["agent-registry", "run-agent"],
  enable: ({ bus, settings, services }) => {
    const registry = services.require("registry");
    const runner = services.require("runner");
    const warned = new Set<string>();
    const handoffTurn = new Map<string, number>();

    const offTurn = bus.on("agent:turn", ({ id, context, turns, continuing }) => {
      const record = registry.get(id);

      if (!continuing || !record || isClosed(record.state)) {
        return;
      }

      const limit = agentLimit(record.contextLimit, context.window, settings);
      const tokens = context.tokens ?? 0;

      const step = limitStep(tokens, limit, {
        warned: warned.has(id),
        requested: record.handoffRequested,
        turnsSinceRequest: turns - (handoffTurn.get(id) ?? turns),
      });

      if (step === "warn") {
        warned.add(id);
        void runner.route(id, { sender: LIMITS_SENDER, text: softWarning(tokens, limit.request) });
        return;
      }

      if (step === "request") {
        warned.add(id);
        handoffTurn.set(id, turns);
        registry.update(id, { handoffRequested: true });
        void runner.route(id, {
          customType: HANDOFF_REQUEST_TYPE,
          text: handoffService.instruction(record.handoffPath),
          details: { reason: "limit", tokens, request: limit.request } satisfies HandoffRequestDetails,
        });
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
