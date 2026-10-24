import type { AgentRuntime, Host } from "../pi-adapter/index.ts";
import type { Bus, Disable, EventMap, ExtensionPaths, Plugin, Services } from "../shared/index.ts";
import { createBus } from "./bus.ts";

export type ExtensionManager<E extends EventMap, S> = {
  bus: Bus<E>;
  services: Services<S>;
  disableAll(): Promise<void>;
};

type ManagerOptions<E extends EventMap, S, C> = {
  host: Host;
  runtime: AgentRuntime;
  settings: C;
  plugins: Plugin<E, S, C>[];
  paths: ExtensionPaths;
  disabled: Iterable<string>;
  onError: (error: unknown) => void;
};

const createServices = <S>(): Services<S> => {
  const values = new Map<keyof S, unknown>();

  return {
    provide: (key, value) => {
      values.set(key, value);
    },
    require: (key) => {
      if (!values.has(key)) {
        throw new Error(`service "${String(key)}" is not provided; enable the plugin that provides it first`);
      }

      return values.get(key) as S[typeof key];
    },
    has: (key) => values.has(key),
  };
};

type Node = { id: string; requires?: string[] };

const orderPlugins = <P extends Node>(plugins: P[]): P[] => {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const ordered: P[] = [];
  const visiting = new Set<string>();

  const visit = (plugin: P) => {
    if (ordered.includes(plugin)) {
      return;
    }

    if (visiting.has(plugin.id)) {
      throw new Error(`plugin dependency cycle at "${plugin.id}"`);
    }

    visiting.add(plugin.id);

    (plugin.requires ?? [])
      .map((id) => byId.get(id))
      .filter((dependency): dependency is P => dependency !== undefined)
      .forEach(visit);

    visiting.delete(plugin.id);
    ordered.push(plugin);
  };

  plugins.forEach(visit);

  return ordered;
};

export const createExtensionManager = <E extends EventMap, S, C>(
  options: ManagerOptions<E, S, C>,
): ExtensionManager<E, S> => {
  const bus = createBus<E>(options.onError);
  const services = createServices<S>();
  const enabled: string[] = [];
  const skipped: string[] = [];
  const disables: Disable[] = [];
  const disabledIds = new Set(options.disabled);

  orderPlugins(options.plugins).forEach((plugin) => {
    if (disabledIds.has(plugin.id)) {
      return;
    }

    const missing = (plugin.requires ?? []).filter((id) => !enabled.includes(id));

    if (missing.length > 0) {
      skipped.push(`${plugin.id} (needs ${missing.join(", ")})`);
      return;
    }

    const disable = plugin.enable({
      host: options.host,
      runtime: options.runtime,
      bus,
      settings: options.settings,
      services,
      root: options.paths.root,
      paths: options.paths,
    });

    enabled.push(plugin.id);

    if (disable) {
      disables.push(disable);
    }
  });

  if (skipped.length > 0) {
    options.host.onSessionStart(() => {
      options.host.ui.notify(
        `plugins skipped because a plugin they need is off: ${skipped.join(", ")}`,
        "warning",
      );
    });
  }

  const disableAll = async () => {
    const pending = disables.splice(0).reverse();

    await pending.reduce(
      (chain, disable) =>
        chain.then(async () => {
          try {
            await disable();
          } catch (error) {
            options.onError(error);
          }
        }),
      Promise.resolve(),
    );
  };

  return {
    bus,
    services,
    disableAll,
  };
};
