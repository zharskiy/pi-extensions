import type { AnyToolSpec } from "../../../../../core/adapter/contract.ts";
import type { Plugin } from "../../model/plugin.ts";
import { type AgentDefinition, type AgentRecord, isClosed } from "../../model/types.ts";
import { createOutbox } from "./outbox.ts";
import { childPromptsFor, createPromptQueue } from "./prompts.ts";
import { createRunner } from "./runner.ts";
import { describeRunAgent, messageAgentTool, runAgentTool } from "./tools.ts";

export const runAgentPlugin: Plugin = {
  id: "run-agent",
  requires: ["agent-registry", "agent-definitions"],
  enable: ({ host, runtime, bus, settings, services }) => {
    const registry = services.require("registry");
    const definitions = services.require("definitions");

    const outbox = createOutbox({
      isBusy: () => !host.isIdle(),
      deliver: (text) => host.sendUserMessage(text),
      onIdle: (handler) => host.onIdle(handler),
    });

    const childTools = (record: AgentRecord): AnyToolSpec[] => {
      const allowed = (definitions.get(record.agent)?.subagents ?? [])
        .map((name) => definitions.get(name))
        .filter((definition): definition is AgentDefinition => definition !== undefined);

      if (allowed.length === 0 || record.depth >= settings.maxDepth) {
        return [];
      }

      const description = describeRunAgent(allowed, {
        callerDepth: record.depth,
        maxDepth: settings.maxDepth,
        maxConcurrent: settings.maxConcurrent,
      });

      const childDeps = { runner, registry };
      const caller = { id: record.id, depth: record.depth };

      const tools: AnyToolSpec[] = [
        runAgentTool(childDeps, description, caller),
        messageAgentTool(childDeps, record.id),
      ];

      if (services.has("agentStatus")) {
        tools.push(services.require("agentStatus").toolFor(record.id));
      }

      return tools;
    };

    const promptQueue = createPromptQueue();

    const runner = createRunner({
      registry,
      runtime,
      bus,
      settings,
      definitions,
      outbox,
      session: () => host.session(),
      handoff: () => (services.has("handoff") ? services.require("handoff") : undefined),
      toolsFor: childTools,
      promptsFor: (record) => childPromptsFor({ ui: host.ui, registry, queue: promptQueue }, record),
    });

    services.provide("runner", runner);

    const invalidators = new Map<string, () => void>();
    let pendingRender: ReturnType<typeof setTimeout> | undefined;

    const scheduleRender = () => {
      if (pendingRender) {
        return;
      }

      pendingRender = setTimeout(() => {
        pendingRender = undefined;

        invalidators.forEach((invalidate, batchId) => {
          invalidate();

          const finished = registry.batch(batchId).every((record) => isClosed(record.state));

          if (finished) {
            invalidators.delete(batchId);
          }
        });
      }, settings.renderThrottleMs);
    };

    const offChanged = bus.on("agent:changed", (record) => {
      if (invalidators.has(record.batchId)) {
        scheduleRender();
      }
    });

    const toolDeps = {
      runner,
      registry,
      onRendered: (batchId: string, invalidate: () => void) => {
        invalidators.set(batchId, invalidate);
      },
    };

    let registeredDescription: string | undefined;

    const registerRunAgent = () => {
      const description = describeRunAgent(definitions.list(), {
        callerDepth: 1,
        maxDepth: settings.maxDepth,
        maxConcurrent: settings.maxConcurrent,
      });

      if (description === registeredDescription) {
        return;
      }

      registeredDescription = description;
      host.registerTool(runAgentTool(toolDeps, description));
    };

    registerRunAgent();
    host.registerTool(messageAgentTool(toolDeps));
    host.onSessionStart(registerRunAgent);

    host.onSessionShutdown(async (reason) => {
      outbox.clear();
      await runner.shutdown(`session ${reason}`);
    });

    return () => {
      offChanged();

      if (pendingRender) {
        clearTimeout(pendingRender);
      }

      invalidators.clear();
    };
  },
};
