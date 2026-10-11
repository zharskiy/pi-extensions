import type { Plugin } from "../../model/plugin.ts";
import { isClosed } from "../../model/types.ts";
import { budgetStep, effectiveBudget, softWarning, turnLimitWarning } from "./budget.ts";

export const LIMITS_SENDER = "pi-subagents";

export const MAX_TURNS_AFTER_HANDOFF = 3;

export const TURN_LIMIT_GRACE = 2;

export const limitsPlugin: Plugin = {
  id: "limits",
  requires: ["agent-registry", "run-agent", "handoff"],
  enable: ({ bus, settings, services }) => {
    const registry = services.require("registry");
    const runner = services.require("runner");
    const handoff = services.require("handoff");
    const warned = new Set<string>();
    const turnWarned = new Set<string>();
    const handoffTurn = new Map<string, number>();

    const send = (id: string, text: string) => runner.route(id, { sender: LIMITS_SENDER, text });

    const checkTurns = (id: string, turns: number) => {
      const record = registry.get(id);
      const maxTurns = record ? services.require("definitions").get(record.agent)?.maxTurns : undefined;

      if (!record || maxTurns === undefined || record.handoffRequested) {
        return;
      }

      if (turns >= maxTurns + TURN_LIMIT_GRACE) {
        void runner.abort(id, `turn limit of ${maxTurns} exceeded`);
        return;
      }

      if (turns >= maxTurns && !turnWarned.has(id)) {
        turnWarned.add(id);
        void send(id, turnLimitWarning(maxTurns));
      }
    };

    const off = bus.on("agent:turn", ({ id, context, turns, continuing }) => {
      const record = registry.get(id);

      if (!continuing || !record || isClosed(record.state)) {
        return;
      }

      const budget = effectiveBudget(record.budgetTokens, context, settings.reserveTokens);
      const tokens = context.tokens ?? 0;

      const step = budgetStep({
        tokens,
        budget,
        softRatio: settings.softBudgetRatio,
        hardRatio: settings.hardBudgetRatio,
        warned: warned.has(id),
        handoffRequested: record.handoffRequested,
        turnsSinceHandoff: turns - (handoffTurn.get(id) ?? turns),
        maxTurnsAfterHandoff: MAX_TURNS_AFTER_HANDOFF,
      });

      if (step === "warn") {
        warned.add(id);
        void send(id, softWarning(tokens, budget));
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
        return;
      }

      checkTurns(id, turns);
    });

    return off;
  },
};
