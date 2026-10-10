import type { AgentRuntime, Host } from "../adapter/contract.ts";
import { type Bus, createBus } from "./bus.ts";
import type { Disable, Plugin, Services } from "./plugin.ts";
import type { Settings } from "./settings.ts";
import type { ServiceMap } from "./types.ts";

export type Contribution = {
  plugin: string;
  kind: "tool" | "command" | "prompt-section" | "main-prompt";
  name: string;
};

export type ManagerReport = {
  enabled: ReadonlyArray<string>;
  skipped: ReadonlyArray<{ id: string; reason: string }>;
  contributions: ReadonlyArray<Contribution>;
};

export type ExtensionManager = {
  bus: Bus;
  services: Services;
  report(): ManagerReport;
  disableAll(): Promise<void>;
};

export type ManagerOptions = {
  host: Host;
  runtime: AgentRuntime;
  settings: Settings;
  plugins: Plugin[];
  packageRoot: string;
  onError?: (error: unknown) => void;
};

const createServices = (): Services => {
  const values = new Map<keyof ServiceMap, unknown>();

  return {
    provide: (key, value) => {
      values.set(key, value);
    },
    require: (key) => {
      if (!values.has(key)) {
        throw new Error(`service "${key}" is not provided; enable the plugin that provides it first`);
      }

      return values.get(key) as ServiceMap[typeof key];
    },
    has: (key) => values.has(key),
  };
};

const recordingHost = (host: Host, plugin: string, contributions: Contribution[]): Host => ({
  ...host,
  ui: host.ui,
  registerTool: (spec) => {
    contributions.push({ plugin, kind: "tool", name: spec.name });
    host.registerTool(spec);
  },
  registerCommand: (name, spec) => {
    contributions.push({ plugin, kind: "command", name });
    host.registerCommand(name, spec);
  },
  setPromptSection: (name, text) => {
    contributions.push({ plugin, kind: "prompt-section", name });
    host.setPromptSection(name, text);
  },
  setMainPrompt: (text) => {
    contributions.push({ plugin, kind: "main-prompt", name: "main-session" });
    host.setMainPrompt(text);
  },
});

export const orderPlugins = (plugins: Plugin[]): Plugin[] => {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const ordered: Plugin[] = [];
  const visiting = new Set<string>();

  const visit = (plugin: Plugin) => {
    if (ordered.includes(plugin)) {
      return;
    }

    if (visiting.has(plugin.id)) {
      throw new Error(`plugin dependency cycle at "${plugin.id}"`);
    }

    visiting.add(plugin.id);

    (plugin.requires ?? [])
      .map((id) => byId.get(id))
      .filter((dependency): dependency is Plugin => dependency !== undefined)
      .forEach(visit);

    visiting.delete(plugin.id);
    ordered.push(plugin);
  };

  plugins.forEach(visit);

  return ordered;
};

export const createExtensionManager = (options: ManagerOptions): ExtensionManager => {
  const onError = options.onError ?? (() => {});
  const bus = createBus(onError);
  const services = createServices();
  const contributions: Contribution[] = [];
  const enabled: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const disables: Disable[] = [];
  const disabledIds = new Set(options.settings.disabledPlugins);

  orderPlugins(options.plugins).forEach((plugin) => {
    if (disabledIds.has(plugin.id)) {
      skipped.push({ id: plugin.id, reason: "disabled in settings" });
      return;
    }

    const missing = (plugin.requires ?? []).filter((id) => !enabled.includes(id));

    if (missing.length > 0) {
      skipped.push({ id: plugin.id, reason: `requires ${missing.join(", ")}` });
      return;
    }

    const host = recordingHost(options.host, plugin.id, contributions);

    const disable = plugin.enable({
      host,
      runtime: options.runtime,
      bus,
      settings: options.settings,
      services,
      packageRoot: options.packageRoot,
    });

    enabled.push(plugin.id);

    if (disable) {
      disables.push(disable);
    }
  });

  const disableAll = async () => {
    const pending = disables.splice(0).reverse();

    await pending.reduce(
      (chain, disable) =>
        chain.then(async () => {
          try {
            await disable();
          } catch (error) {
            onError(error);
          }
        }),
      Promise.resolve(),
    );
  };

  return {
    bus,
    services,
    report: () => ({
      enabled: Array.from(enabled),
      skipped: Array.from(skipped),
      contributions: Array.from(contributions),
    }),
    disableAll,
  };
};
