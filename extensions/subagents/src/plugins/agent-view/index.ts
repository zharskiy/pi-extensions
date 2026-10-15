import type { OverlayApi } from "../../../../../core/adapter/contract.ts";
import { cutChars, errorText } from "../../components/format.ts";
import { watchAgents } from "../../components/refresh.ts";
import { stateWord } from "../../components/state-text.ts";
import { UNKNOWN_LIMIT } from "../../model/context-limit.ts";
import type { Plugin } from "../../model/plugin.ts";
import { type AgentRecord, chainLinks } from "../../model/types.ts";
import { createAgentList } from "./list.ts";
import { listedTerminals, visibleRecords } from "./list-model.ts";
import { createAgentSource } from "./loader.ts";
import { type AgentsOverlay, createAgentsOverlay, type OverlayParts, type OverlayStart } from "./overlay.ts";
import { createAgentView } from "./view.ts";

export const agentViewPlugin: Plugin = {
  id: "agent-view",
  requires: ["agent-registry"],
  enable: ({ host, runtime, bus, services, settings }) => {
    const registry = services.require("registry");
    const cleared = new Set<string>();

    const limitOf = (agent: string | undefined) => {
      const definition =
        agent && services.has("definitions") ? services.require("definitions").get(agent) : undefined;

      return definition?.limit ?? UNKNOWN_LIMIT;
    };

    const source = createAgentSource({ host, runtime, registry, limitOf });

    const stop = (id: string) => (services.has("runner") ? services.require("runner").stop(id) : undefined);

    const watch =
      (relevant: (record: AgentRecord) => boolean) =>
      (tickMs: () => number | undefined, onChange: () => void, onTick?: () => void) =>
        watchAgents(bus, { relevant, tickMs, throttleMs: () => settings.renderThrottleMs, onChange, onTick });

    const viewWatch = (id: string) =>
      watch((record) => chainLinks(registry, record).some((link) => link.id === id));

    const listed = () =>
      listedTerminals(visibleRecords(registry.list(), Date.now(), settings.lingerMs, cleared));

    const partsFor = (api: OverlayApi): OverlayParts => ({
      list: (hooks) =>
        createAgentList(
          {
            records: () => registry.list(),
            lingerMs: settings.lingerMs,
            cleared,
            stop,
            watch: watch(() => true),
            ...hooks,
          },
          api,
        ),
      view: (id, found, back, leave) =>
        createAgentView(
          {
            load: source.loader(id, found),
            back,
            reserveTokens: settings.reserveTokens,
            stop: () => stop(id),
            watch: viewWatch(id),
            leave,
          },
          api,
        ),
    });

    let active: AgentsOverlay | undefined;

    const openOverlay = (start: OverlayStart) =>
      host.ui.openOverlay((outer) => {
        const forget = () => {
          if (active === overlay) {
            active = undefined;
          }
        };
        const api: OverlayApi = {
          ...outer,
          close: () => {
            forget();
            outer.close();
          },
        };
        const overlay = createAgentsOverlay(api, start, partsFor(api));

        active = overlay;

        return {
          ...overlay,
          dispose: () => {
            forget();
            overlay.dispose();
          },
        };
      });

    const terminalOrNotice = (id: string) => {
      try {
        const terminal = source.find(id);

        if (!terminal) {
          host.ui.notify(`pi-subagents: unknown agent "${id}"`, "warning");
        }

        return terminal;
      } catch (error) {
        host.ui.notify(`pi-subagents: cannot read ${errorText(error)}`, "warning");

        return undefined;
      }
    };

    const open = async (id: string) => {
      const found = terminalOrNotice(id);

      if (!found) {
        return;
      }

      await openOverlay({ kind: "view", id, found });
    };

    services.provide("agentView", { open });

    const label = (record: AgentRecord) =>
      cutChars(`${record.id} · ${stateWord(record.state)} · ${record.description}`, 100);

    host.registerCommand("agents", {
      description: "Open the agents list, or one agent's view by id. Usage: /agents [id]",
      complete: (prefix) =>
        listed()
          .filter((record) => record.id.startsWith(prefix))
          .map((record) => ({ value: record.id, label: label(record) })),
      run: async (args) => {
        const id = args.trim();

        if (id) {
          await open(id);
          return;
        }

        await openOverlay({ kind: "list" });
      },
    });

    const offLeft = host.ui.onEmptyEditorLeft(() => {
      if (listed().length === 0) {
        return;
      }

      openOverlay({ kind: "list" }).catch((error: unknown) => {
        host.ui.notify(`pi-subagents: cannot open the agents list: ${errorText(error)}`, "warning");
      });
    });

    return () => {
      offLeft();
      active?.close();
    };
  },
};
