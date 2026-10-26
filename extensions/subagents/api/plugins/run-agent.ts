import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyToolSpec } from "../../../../platform/pi-adapter/index.ts";
import {
  BACKGROUND_WORK_CHANNEL,
  HANDOFF_REQUEST_TYPE,
  HANDOFF_SEED_TYPE,
  handoffTool,
} from "../../../../platform/shared/index.ts";
import {
  EXPAND_BINDING,
  handoffRequestMessage,
  handoffSeedMessage,
  handoffToolRows,
} from "../../../../platform/ui-kit/index.ts";
import { watchAgents } from "../../core/components/refresh.ts";
import {
  type AgentDefinition,
  type AgentRecord,
  allowlist,
  isClosed,
  MAIN_CALLER,
  subagentNames,
} from "../../core/model/agent-record.ts";
import { handoffService } from "../../core/model/handoff.ts";
import { NAMESPACE } from "../../core/model/paths.ts";
import type { Plugin } from "../../core/model/plugin.ts";
import { createBackgroundWork } from "../../core/run-agent/background-work.ts";
import { joinTexts } from "../../core/run-agent/outbox.ts";
import { createRunner } from "../../core/run-agent/runner.ts";
import {
  createPendingCalls,
  describeRunAgent,
  messageAgentTool,
  runAgentTool,
} from "../../core/run-agent/tools.ts";
import { pendingRows } from "../../ui/run-agent/pending-rows.ts";

const readPrompt = (root: string, file: string) => readFileSync(join(root, "prompts", file), "utf8").trim();

export const runAgentPlugin: Plugin = {
  id: "run-agent",
  requires: ["agent-registry", "agent-definitions"],
  enable: ({ host, runtime, bus, settings, services, root }) => {
    const registry = services.require("registry");
    const definitions = services.require("definitions");

    const waking: string[] = [];
    const work = createBackgroundWork((count) => {
      host.publish(BACKGROUND_WORK_CHANNEL, { source: NAMESPACE, count });
    });
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
        work.sent();
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
        handoffTool({
          target: () => {
            const live = registry.get(record.id);

            return live && { path: live.handoffPath, requested: live.handoffRequested };
          },
          validate: handoffService.validate,
          rows: handoffToolRows(() => registry.get(record.id)?.handoffPath),
        }),
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

      const childDeps = { runner, registry, calls, rows: pendingRows({ registry, hints }) };

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

    const keyText = (binding: string) => host.ui.keyText(binding);

    host.registerMessageRenderer(HANDOFF_REQUEST_TYPE, handoffRequestMessage(keyText));
    host.registerMessageRenderer(HANDOFF_SEED_TYPE, handoffSeedMessage(keyText));

    const runner = createRunner({
      registry,
      runtime,
      bus,
      settings,
      definitions,
      outbox,
      session: () => host.session(),
      toolsFor: childTools,
    });

    services.provide("runner", runner);

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

    const offStarted = bus.on("batch:started", ({ batchId, callerId, wait }) => {
      if (callerId === MAIN_CALLER && !wait) {
        work.started(batchId);
      }
    });

    const offSettled = bus.on("batch:settled", ({ batchId }) => {
      work.settled(batchId);
      safeInvalidate(batchId);
      invalidators.delete(batchId);
    });

    host.onAssistantEnd(() => {
      work.answered();
    });

    host.onIdle(({ aborted }) => {
      work.idle(aborted);
    });

    const onRendered = (batchId: string, invalidate: () => void) => {
      if (invalidators.has(batchId) || registry.batch(batchId).some((record) => !isClosed(record.state))) {
        invalidators.set(batchId, invalidate);
      }
    };

    const toolDeps = { runner, registry, calls, rows: pendingRows({ registry, hints, onRendered }) };

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
      work.reset();
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
      offStarted();
      offSettled();
      invalidators.clear();
      calls.clear();
    };
  },
};
