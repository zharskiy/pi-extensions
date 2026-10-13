import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyToolSpec } from "../../../../../core/adapter/contract.ts";
import type { Plugin } from "../../model/plugin.ts";
import { type AgentDefinition, type AgentRecord, isClosed, subagentNames } from "../../model/types.ts";
import { createHandoff } from "./handoff.ts";
import { createOutbox } from "./outbox.ts";
import { childPromptsFor, createPromptQueue } from "./prompts.ts";
import { createRunner } from "./runner.ts";
import { describeRunAgent, messageAgentTool, runAgentTool } from "./tools.ts";

const readPrompt = (root: string, file: string) => readFileSync(join(root, "prompts", file), "utf8").trim();

export const runAgentPlugin: Plugin = {
  id: "run-agent",
  requires: ["agent-registry", "agent-definitions"],
  enable: ({ host, runtime, bus, settings, services, root }) => {
    const registry = services.require("registry");
    const definitions = services.require("definitions");

    const outbox = createOutbox({
      isBusy: () => !host.isIdle(),
      deliver: (text) => host.sendUserMessage(text),
      onIdle: (handler) => host.onIdle(handler),
    });

    const childTools = (record: AgentRecord): AnyToolSpec[] => {
      const own = definitions.get(record.agent);
      const names = definitions.list().map((definition) => definition.name);
      const allowed = (own ? subagentNames(own, names) : [])
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

      const tools: AnyToolSpec[] = [
        runAgentTool(childDeps, description, record.id),
        messageAgentTool(childDeps, record.id),
      ];

      if (services.has("agentStatus")) {
        tools.push(services.require("agentStatus").toolFor(record.id));
      }

      return tools;
    };

    const promptQueue = createPromptQueue();
    const handoff = createHandoff(root);

    const runner = createRunner({
      registry,
      runtime,
      bus,
      settings,
      definitions,
      outbox,
      session: () => host.session(),
      handoff,
      toolsFor: childTools,
      promptsFor: (record) => childPromptsFor({ ui: host.ui, registry, queue: promptQueue }, record),
    });

    services.provide("runner", runner);
    services.provide("handoff", handoff);

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

    const mainPrompt = readPrompt(root, "main-session.md");
    const statusPrompt = readPrompt(root, "main-session-agent-status.md");

    registerRunAgent();
    host.registerTool(messageAgentTool(toolDeps));
    host.onSessionStart(() => {
      registerRunAgent();
      host.setMainPrompt(services.has("agentStatus") ? `${mainPrompt}\n\n${statusPrompt}` : mainPrompt);
    });

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
