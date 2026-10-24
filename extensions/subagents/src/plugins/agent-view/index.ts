import type { OverlayApi } from "../../../../../pi-adapter/index.ts";
import { type SelectOption, selectForm } from "../../../../../ui-kit/index.ts";
import { cutChars, DOT, errorText } from "../../components/format.ts";
import { watchAgents } from "../../components/refresh.ts";
import { stateWord } from "../../components/state-text.ts";
import { NAMESPACE } from "../../model/paths.ts";
import type { Plugin } from "../../model/plugin.ts";
import { type AgentRecord, chainLinks } from "../../model/types.ts";
import { createAgentList } from "./list.ts";
import { countsText, listCounts, listedTerminals, visibleRecords } from "./list-model.ts";
import { createAgentSource } from "./loader.ts";
import { type AgentsOverlay, createAgentsOverlay, type OverlayParts, type OverlayStart } from "./overlay.ts";
import { createAgentView } from "./view.ts";

const SETUP_PREFIX = "setup ";

const SUBCOMMANDS = ["view", "create", "setup"] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

type SetupWord = Exclude<Subcommand, "view">;

const SUBCOMMAND_TEXT: Record<Subcommand, string> = {
  view: "agents list",
  create: "new agent",
  setup: "model, thinking and skills per agent",
};

const MENU_TEXT: Record<Subcommand, string> = {
  ...SUBCOMMAND_TEXT,
  create: "new agent; the main session asks what it is for and writes it",
};

const NO_TERMINAL = `${NAMESPACE}: the agents list needs the interactive terminal; /agents create works in any mode`;

const isSubcommand = (word: string): word is Subcommand => (SUBCOMMANDS as readonly string[]).includes(word);

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

      const options: SelectOption<Subcommand>[] = [
        { value: "view", label: "view", description: viewText() },
        { value: "setup", label: "setup", description: MENU_TEXT.setup },
        { value: "create", label: "create", description: MENU_TEXT.create },
      ];
      const choice = await host.ui.showForm(selectForm({ title: "Agents", options }));

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
