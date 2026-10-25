import type { OverlayApi } from "../../../../platform/pi-adapter/index.ts";
import { DOT, errorText } from "../../../../platform/shared/index.ts";
import { countsText, listCounts, listedTerminals, visibleRecords } from "../../core/agent-view/list-model.ts";
import { createAgentSource } from "../../core/agent-view/source.ts";
import { cutChars } from "../../core/components/receipt.ts";
import { watchAgents } from "../../core/components/refresh.ts";
import { type AgentRecord, chainLinks } from "../../core/model/agent-record.ts";
import { NAMESPACE } from "../../core/model/paths.ts";
import type { Plugin } from "../../core/model/plugin.ts";
import { createAgentList } from "../../ui/agent-view/list.ts";
import {
  type AgentsOverlay,
  createAgentsOverlay,
  type OverlayParts,
  type OverlayStart,
} from "../../ui/agent-view/overlay.ts";
import {
  isSubcommand,
  SUBCOMMAND_TEXT,
  SUBCOMMANDS,
  type Subcommand,
  subcommandPicker,
} from "../../ui/agent-view/picker.ts";
import { createAgentView } from "../../ui/agent-view/view.ts";
import { stateWord } from "../../ui/components/state-text.ts";

const SETUP_PREFIX = "setup ";

type SetupWord = Exclude<Subcommand, "view">;

const NO_TERMINAL = `${NAMESPACE}: the agents list needs the interactive terminal; /agents create works in any mode`;

export const agentViewPlugin: Plugin = {
  id: "agent-view",
  requires: ["agent-registry"],
  enable: ({ host, runtime, bus, services, settings }) => {
    const registry = services.require("registry");
    const cleared = new Set<string>();

    const source = createAgentSource({ runtime, registry });

    const stop = (id: string) => (services.has("runner") ? services.require("runner").stop(id) : undefined);

    const watch =
      (relevant: (record: AgentRecord) => boolean) =>
      (tickMs: () => number | undefined, onChange: () => void, onTick?: () => void) =>
        watchAgents(bus, { relevant, tickMs, throttleMs: () => settings.renderThrottleMs, onChange, onTick });

    const viewWatch = (id: string) =>
      watch((record) => chainLinks(registry, record).some((link) => link.id === id));

    const listed = () => listedTerminals(visibleRecords(registry.list(), cleared));

    const partsFor = (api: OverlayApi): OverlayParts => ({
      list: (hooks) =>
        createAgentList(
          {
            records: () => registry.list(),
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
            copy: (text) => host.ui.copyText(text),
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
      const terminal = source.find(id);

      if (!terminal) {
        host.ui.notify(`${NAMESPACE}: unknown agent "${id}"`, "warning");
      }

      return terminal;
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
      cutChars(`${record.id}${DOT}${stateWord(record.state)}${DOT}${record.description}`, 100);

    const setup = () => (services.has("agentSetup") ? services.require("agentSetup") : undefined);

    const subcommands = (prefix: string) => {
      const service = setup();

      return SUBCOMMANDS.filter((word) => word.startsWith(prefix)).flatMap(
        (word): { value: string; label: string }[] => {
          if (word === "view") {
            return [{ value: word, label: `${word}${DOT}${SUBCOMMAND_TEXT[word]}` }];
          }

          return service
            ? [{ value: word, label: `${word}${DOT}${SUBCOMMAND_TEXT[word]}: ${service.usage[word]}` }]
            : [];
        },
      );
    };

    const openList = async () => {
      if (host.session().mode !== "tui") {
        host.ui.notify(NO_TERMINAL, "info");
        return;
      }

      await openOverlay({ kind: "list" });
    };

    const runSetupWord = async (word: SetupWord, args: string) => {
      const service = setup();

      if (!service) {
        host.ui.notify(
          `${NAMESPACE}: /agents ${word} needs the agent-setup plugin, which is disabled`,
          "error",
        );
        return;
      }

      await (word === "create" ? service.create(args) : service.run(args));
    };

    const runSubcommand = (word: Subcommand, args: string) =>
      word === "view" ? openList() : runSetupWord(word, args);

    const viewText = () => {
      const { running, finished } = listCounts(visibleRecords(registry.list(), cleared));
      const counts = countsText(running, finished);

      return counts ? SUBCOMMAND_TEXT.view + DOT + counts : SUBCOMMAND_TEXT.view;
    };

    const menu = async () => {
      if (!setup() || host.session().mode !== "tui") {
        await openList();
        return;
      }

      const choice = await host.ui.showForm(subcommandPicker(viewText()));

      if (choice) {
        await runSubcommand(choice, "");
      }
    };

    const usage = setup()?.usage;
    const usageText = usage ? ` | ${usage.create} | ${usage.setup}` : "";

    const setupCompletions = (prefix: string) =>
      (setup()?.complete(prefix.slice(SETUP_PREFIX.length)) ?? []).map((entry) => ({
        value: `${SETUP_PREFIX}${entry.value}`,
        label: entry.label,
      }));

    host.registerCommand("agents", {
      description: `Agents: list, setup or create. Usage: /agents [view | <id>]${usageText}`,
      complete: (prefix) =>
        prefix.startsWith(SETUP_PREFIX)
          ? setupCompletions(prefix)
          : [
              ...subcommands(prefix),
              ...listed()
                .filter((record) => record.id.startsWith(prefix))
                .map((record) => ({ value: record.id, label: label(record) })),
            ],
      run: async (args) => {
        const id = args.trim();
        const [word, ...rest] = id.split(/\s+/);

        if (word && isSubcommand(word)) {
          await runSubcommand(word, rest.join(" "));
          return;
        }

        if (id) {
          await open(id);
          return;
        }

        await menu();
      },
    });

    const offLeft = host.ui.onEmptyEditorLeft(() => {
      openOverlay({ kind: "list" }).catch((error: unknown) => {
        host.ui.notify(`${NAMESPACE}: cannot open the agents list: ${errorText(error)}`, "warning");
      });
    });

    return () => {
      offLeft();
      active?.close();
    };
  },
};
