import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UNKNOWN_LIMIT } from "../../model/context-limit.ts";
import { agentsDirFor } from "../../model/paths.ts";
import type { Plugin } from "../../model/plugin.ts";
import { type AgentRecord, chainLinks, chainTerminal, type RouteResult } from "../../model/types.ts";
import { createModeStore, viewStatePath } from "./mode-store.ts";
import { createAgentView, type ViewData } from "./view.ts";

export const COMMAND = "agents";

export const REFRESH_MS = 300;

export const agentViewPlugin: Plugin = {
  id: "agent-view",
  requires: ["agent-registry"],
  enable: ({ host, runtime, bus, services, settings }) => {
    const registry = services.require("registry");

    const definedLimit = (agent: string | undefined) => {
      const definition =
        agent && services.has("definitions") ? services.require("definitions").get(agent) : undefined;

      return definition?.limit ?? UNKNOWN_LIMIT;
    };

    const fromManifest = (id: string): AgentRecord | undefined => {
      const path = join(agentsDirFor(host.session()), id, "manifest.json");

      if (!existsSync(path)) {
        return undefined;
      }

      const manifest = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentRecord>;

      return {
        turns: 0,
        toolCalls: 0,
        tokens: 0,
        lastText: "",
        handoffRequested: false,
        contextLimit: definedLimit(manifest.agent),
        chainIndex: 1,
        version: 0,
        handoffPath: join(agentsDirFor(host.session()), id, "handoff.md"),
        dir: join(agentsDirFor(host.session()), id),
        task: manifest.description ?? "",
        ...manifest,
      } as AgentRecord;
    };

    const findRecord = (id: string) => registry.get(id) ?? fromManifest(id);

    const followChain = (id: string) => {
      const live = registry.get(id);

      return live ? chainTerminal(registry, live) : (fromManifest(id) as AgentRecord);
    };

    const load = (id: string): ViewData => {
      const record = followChain(id);
      const openedId = record.id === id ? undefined : id;

      if (!record.sessionFile || !existsSync(record.sessionFile)) {
        return { record, openedId, error: "session file not written yet" };
      }

      try {
        return { record, openedId, session: runtime.readSession(record.sessionFile) };
      } catch (error) {
        return { record, openedId, error: `cannot read session: ${(error as Error).message}` };
      }
    };

    const inChain = (record: AgentRecord, id: string) =>
      chainLinks(registry, record).some((link) => link.id === id);

    const send = async (id: string, text: string): Promise<RouteResult> => {
      if (!services.has("runner")) {
        return { ok: false, error: "the agent runner is not enabled" };
      }

      return services.require("runner").route(id, { sender: "user", text });
    };

    const open = async (id: string) => {
      if (!findRecord(id)) {
        host.ui.notify(`pi-subagents: unknown agent "${id}"`, "warning");
        return;
      }

      const agentDir = host.session()?.agentDir;
      const modes = agentDir ? createModeStore(viewStatePath(agentDir)) : undefined;

      await host.ui.openOverlay((api) =>
        createAgentView(
          {
            load: () => load(id),
            modes,
            context: {
              softRatio: settings.softContextRatio,
              reserveTokens: settings.reserveTokens,
              estimate: (text) => runtime.estimateTokens(text),
            },
            stop: () => (services.has("runner") ? services.require("runner").stop(id) : undefined),
            send: (text) => send(id, text),
            subscribe: (onChange) => {
              let timer: ReturnType<typeof setTimeout> | undefined;

              const off = bus.on("agent:changed", (record) => {
                if (timer || !inChain(record, id)) {
                  return;
                }

                timer = setTimeout(() => {
                  timer = undefined;
                  onChange();
                }, REFRESH_MS);
              });

              return () => {
                off();

                if (timer) {
                  clearTimeout(timer);
                }
              };
            },
          },
          api,
        ),
      );
    };

    services.provide("agentView", { open });

    const label = (record: AgentRecord) =>
      `${record.id} · ${record.state} · ${record.description}`.slice(0, 100);

    host.registerCommand(COMMAND, {
      description: "Open an agent's view: effective prompt and transcript. Usage: /agents [id]",
      complete: (prefix) =>
        registry
          .list()
          .filter((record) => record.id.startsWith(prefix))
          .map((record) => ({ value: record.id, label: label(record) })),
      run: async (args) => {
        const id = args.trim();

        if (id) {
          await open(id);
          return;
        }

        if (services.has("agentList")) {
          await services.require("agentList").open();
          return;
        }

        const records = registry.list();

        if (records.length === 0) {
          host.ui.notify("pi-subagents: no agents in this session yet", "info");
          return;
        }

        const choice = await host.ui.select("Open agent", records.map(label));
        const picked = records.find((record) => label(record) === choice);

        if (picked) {
          await open(picked.id);
        }
      },
    });

    return undefined;
  },
};
