import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyToolSpec } from "../../../../../core/adapter/contract.ts";
import type { Plugin } from "../../model/plugin.ts";
import {
  type AgentDefinition,
  type AgentRecord,
  chainLinks,
  isClosed,
  MAIN_CALLER,
  subagentNames,
} from "../../model/types.ts";
import { CLOSED_ENTRY, type ClosedEntry, closedEntryOf, renderClosedEntry } from "./completion.ts";
import { createHandoff } from "./handoff.ts";
import { createOutbox, joinTexts, type OutboxItem } from "./outbox.ts";
import { createRunner } from "./runner.ts";
import { describeRunAgent, messageAgentTool, runAgentTool } from "./tools.ts";

const readPrompt = (root: string, file: string) => readFileSync(join(root, "prompts", file), "utf8").trim();

export const runAgentPlugin: Plugin = {
  id: "run-agent",
  requires: ["agent-registry", "agent-definitions"],
  enable: ({ host, runtime, bus, settings, services, root }) => {
    const registry = services.require("registry");
    const definitions = services.require("definitions");

    const waking: OutboxItem[] = [];

    const wake = () => {
      const items = waking.splice(0);

      if (items.length === 0) {
        return;
      }

      host.sendHiddenMessage({
        customType: "pi-subagents:wake",
        text: joinTexts(items),
        details: { v: 1, batches: items.map((item) => item.batchId) },
      });
    };

    const outbox = createOutbox({
      isBusy: () => false,
      deliver: (items) => {
        if (waking.length === 0) {
          queueMicrotask(wake);
        }

        waking.push(...items);
      },
      onIdle: () => {},
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

    let shuttingDown = false;
    const awaitingCleanup = new Set<string>();

    const appendClosed = (record: AgentRecord) => {
      host.appendEntry(CLOSED_ENTRY, closedEntryOf(record, chainLinks(registry, record)));
    };

    const offClosed = bus.on("agent:closed", (record) => {
      if (shuttingDown || record.callerId !== MAIN_CALLER || record.successorId) {
        return;
      }

      if (record.worktree && record.worktree.cleanup === undefined) {
        awaitingCleanup.add(record.id);
        return;
      }

      appendClosed(record);
    });

    const offCleanup = bus.on("agent:changed", (record) => {
      if (shuttingDown || !awaitingCleanup.has(record.id) || record.worktree?.cleanup === undefined) {
        return;
      }

      awaitingCleanup.delete(record.id);
      appendClosed(record);
    });

    host.registerEntryRenderer<ClosedEntry>(CLOSED_ENTRY, (data, _state, theme) =>
      renderClosedEntry(data, theme),
    );

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
    let pendingRender: ReturnType<typeof setTimeout> | undefined;

    const safeInvalidate = (batchId: string) => {
      try {
        invalidators.get(batchId)?.();
      } catch {
        invalidators.delete(batchId);
      }
    };

    const scheduleRender = () => {
      if (pendingRender) {
        return;
      }

      pendingRender = setTimeout(() => {
        pendingRender = undefined;

        Array.from(invalidators.keys()).forEach(safeInvalidate);
      }, settings.renderThrottleMs);
    };

    const offChanged = bus.on("agent:changed", (record) => {
      if (invalidators.has(record.batchId)) {
        scheduleRender();
      }
    });

    const offSettled = bus.on("batch:settled", ({ batchId }) => {
      safeInvalidate(batchId);
      invalidators.delete(batchId);
    });

    const toolDeps = {
      runner,
      registry,
      onRendered: (batchId: string, invalidate: () => void) => {
        if (registry.batch(batchId).some((record) => !isClosed(record.state))) {
          invalidators.set(batchId, invalidate);
        }
      },
    };

    const specs: AnyToolSpec[] = [];

    services.provide("tools", {
      list: () => [...specs],
      add: (spec) => {
        specs.push(spec);
      },
    });

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

      const spec = runAgentTool(toolDeps, description);

      specs[0] = spec as unknown as AnyToolSpec;
      host.registerTool(spec);
    };

    const mainPrompt = readPrompt(root, "main-session.md");
    const statusPrompt = readPrompt(root, "main-session-agent-status.md");

    const messageAgent = messageAgentTool(toolDeps);

    registerRunAgent();
    specs[1] = messageAgent as unknown as AnyToolSpec;
    host.registerTool(messageAgent);
    host.onSessionStart(() => {
      registerRunAgent();
      host.setMainPrompt(services.has("agentStatus") ? `${mainPrompt}\n\n${statusPrompt}` : mainPrompt);
    });

    host.onSessionShutdown(async (reason) => {
      shuttingDown = true;
      outbox.clear();
      waking.length = 0;
      await runner.shutdown(`session ${reason}`);
    });

    return () => {
      offChanged();
      offSettled();
      offClosed();
      offCleanup();

      if (pendingRender) {
        clearTimeout(pendingRender);
      }

      invalidators.clear();
    };
  },
};
