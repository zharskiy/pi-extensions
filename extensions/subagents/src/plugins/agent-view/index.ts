import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionRecord } from "../../../../../core/adapter/contract.ts";
import { watchAgents } from "../../components/refresh.ts";
import { UNKNOWN_LIMIT } from "../../model/context-limit.ts";
import { agentsDirFor, handoffPathFor, MANIFEST_FILE } from "../../model/paths.ts";
import type { Plugin } from "../../model/plugin.ts";
import {
  type AgentRecord,
  chainLinks,
  chainTerminal,
  isClosed,
  type RouteResult,
} from "../../model/types.ts";
import { createModeStore, viewStatePath } from "./mode-store.ts";
import { createAgentView, type ViewData } from "./view.ts";

type CachedSession = { file: string; size: number; mtimeMs: number; session: SessionRecord };

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
      const dir = join(agentsDirFor(host.session()), id);
      const path = join(dir, MANIFEST_FILE);

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
        handoffPath: handoffPathFor(host.session(), id),
        dir,
        ...manifest,
      } as AgentRecord;
    };

    const pastTerminal = (record: AgentRecord): AgentRecord => {
      const successor = record.successorId ? fromManifest(record.successorId) : undefined;

      return successor ? pastTerminal(successor) : record;
    };

    const findTerminal = (id: string) => {
      const live = registry.get(id);

      if (live) {
        return chainTerminal(registry, live);
      }

      const past = fromManifest(id);

      return past ? pastTerminal(past) : undefined;
    };

    const createLoader = (id: string, found: AgentRecord) => {
      let cached: CachedSession | undefined;

      const readSession = (file: string) => {
        const stat = statSync(file, { throwIfNoEntry: false });

        if (!stat) {
          return undefined;
        }

        if (cached?.file === file && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          return cached.session;
        }

        const session = runtime.readSession(file);

        cached = { file, size: stat.size, mtimeMs: stat.mtimeMs, session };

        return session;
      };

      return (): ViewData => {
        const live = registry.get(id);
        const record = live ? chainTerminal(registry, live) : found;
        const openedId = record.id === id ? undefined : id;

        try {
          const session = record.sessionFile ? readSession(record.sessionFile) : undefined;

          return session
            ? { record, openedId, session }
            : { record, openedId, error: "session file not written yet" };
        } catch (error) {
          return { record, openedId, error: `cannot read session: ${(error as Error).message}` };
        }
      };
    };

    const inChain = (record: AgentRecord, id: string) =>
      chainLinks(registry, record).some((link) => link.id === id);

    const send = async (id: string, text: string): Promise<RouteResult> => {
      if (!services.has("runner")) {
        return { ok: false, error: "the agent runner is not enabled" };
      }

      return services.require("runner").route(id, { sender: "user", text });
    };

    const terminalOrNotice = (id: string) => {
      try {
        const terminal = findTerminal(id);

        if (!terminal) {
          host.ui.notify(`pi-subagents: unknown agent "${id}"`, "warning");
        }

        return terminal;
      } catch (error) {
        host.ui.notify(
          `pi-subagents: cannot read manifest of "${id}": ${(error as Error).message}`,
          "warning",
        );

        return undefined;
      }
    };

    const open = async (id: string) => {
      const terminal = terminalOrNotice(id);

      if (!terminal) {
        return;
      }

      const modes = createModeStore(viewStatePath(host.session().agentDir));
      const load = createLoader(id, terminal);

      const ticking = () => {
        const live = registry.get(id);

        return live !== undefined && !isClosed(chainTerminal(registry, live).state);
      };

      await host.ui.openOverlay((api) =>
        createAgentView(
          {
            load,
            modes,
            context: {
              softRatio: settings.softContextRatio,
              reserveTokens: settings.reserveTokens,
              estimate: (text) => runtime.estimateTokens(text),
            },
            stop: () => (services.has("runner") ? services.require("runner").stop(id) : undefined),
            send: (text) => send(id, text),
            subscribe: (onChange) =>
              watchAgents(bus, {
                relevant: (record) => inChain(record, id),
                tickMs: () => (ticking() ? 1_000 : undefined),
                throttleMs: () => settings.renderThrottleMs,
                onChange,
              }),
          },
          api,
        ),
      );
    };

    services.provide("agentView", { open });

    const label = (record: AgentRecord) =>
      `${record.id} · ${record.state} · ${record.description}`.slice(0, 100);

    host.registerCommand("agents", {
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
  },
};
