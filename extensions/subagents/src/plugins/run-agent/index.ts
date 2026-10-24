import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPAND_BINDING } from "../../../../../core/manager/hints.ts";
import type { AnyToolSpec } from "../../../../../pi-adapter/index.ts";
import { watchAgents } from "../../components/refresh.ts";
import type { Plugin } from "../../model/plugin.ts";
import {
  type AgentDefinition,
  type AgentRecord,
  allowlist,
  isClosed,
  subagentNames,
} from "../../model/types.ts";
import { createHandoff } from "./handoff.ts";
import { handoffTool } from "./handoff-tool.ts";
import { joinTexts } from "./outbox.ts";
import { createRunner } from "./runner.ts";
import { createPendingCalls, describeRunAgent, messageAgentTool, runAgentTool } from "./tools.ts";

const readPrompt = (root: string, file: string) => readFileSync(join(root, "prompts", file), "utf8").trim();

export const runAgentPlugin: Plugin = {
  id: "run-agent",
  requires: ["agent-registry", "agent-definitions"],
  enable: ({ host, runtime, bus, settings, services, root }) => {
    const registry = services.require("registry");
    const definitions = services.require("definitions");

    const waking: string[] = [];
    const calls = createPendingCalls();
    const hints = {
      manage: () => !settings.disabledPlugins.includes("agent-panel"),
      list: () => !settings.disabledPlugins.includes("agent-view"),
      expandKey: () => host.ui.keyText(EXPAND_BINDING),
    };

    const wake = () => {
      const texts = waking.splice(0);

      if (texts.length > 0) {
        host.sendHiddenMessage({ customType: "pi-subagents:wake", text: joinTexts(texts) });
      }
    };

    const outbox = {
      post: (text: string) => {
        if (waking.length === 0) {
          queueMicrotask(wake);
        }

        waking.push(text);
      },
    };

    const childTools = (record: AgentRecord): AnyToolSpec[] => {
      const own = definitions.get(record.agent);
      const names = definitions.list().map((definition) => definition.name);
      const allowed = (own ? subagentNames(own, names) : [])
        .map((name) => definitions.get(name))
        .filter((definition): definition is AgentDefinition => definition !== undefined);

      const granted = own && allowlist(own.tools)?.includes("fetch") && services.has("fetchTool");
      const extra: AnyToolSpec[] = [
        handoffTool({ registry, handoff }, record.id),
        ...(granted ? [services.require("fetchTool").tool()] : []),
      ];

      if (allowed.length === 0 || record.depth >= settings.maxDepth) {
        return extra;
      }

      const description = describeRunAgent(allowed, {
        callerDepth: record.depth,
        maxDepth: settings.maxDepth,
        maxConcurrent: settings.maxConcurrent,
        childCap: settings.maxChildrenPerAgent,
      });

      const childDeps = { runner, registry, calls, hints };

      const tools: AnyToolSpec[] = [
        ...extra,
        runAgentTool(childDeps, description, record.id),
        messageAgentTool(childDeps, record.id),
      ];

      if (services.has("agentStatus")) {
        tools.push(services.require("agentStatus").toolFor(record.id));
      }

      return tools;
    };

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
    });

    services.provide("runner", runner);
    services.provide("handoff", handoff);

    const invalidators = new Map<string, () => void>();

    const safeInvalidate = (batchId: string) => {
      try {
        invalidators.get(batchId)?.();
      } catch {
        invalidators.delete(batchId);
      }
    };

    const offChanged = watchAgents(bus, {
      relevant: (record) => invalidators.has(record.batchId),
      tickMs: () => undefined,
      throttleMs: () => settings.renderThrottleMs,
      onChange: () => Array.from(invalidators.keys()).forEach(safeInvalidate),
    });

    const offSettled = bus.on("batch:settled", ({ batchId }) => {
      safeInvalidate(batchId);
      invalidators.delete(batchId);
    });

    const toolDeps = {
      runner,
      registry,
      calls,
      hints,
      onRendered: (batchId: string, invalidate: () => void) => {
        if (invalidators.has(batchId) || registry.batch(batchId).some((record) => !isClosed(record.state))) {
          invalidators.set(batchId, invalidate);
        }
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
      waking.length = 0;
      calls.clear();
      await runner.shutdown(`session ${reason}`);
    });

    return () => {
      offChanged();
      offSettled();
      invalidators.clear();
      calls.clear();
    };
  },
};
