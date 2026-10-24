import { resolve } from "node:path";
import { type AgentRuntime, createPiExtension, type Host, type SessionInfo } from "../pi-adapter/index.ts";
import {
  type EventMap,
  type ExtensionPaths,
  loadSettingsFiles,
  type Plugin,
  type SettingsSchema,
} from "../shared/index.ts";
import { createExtensionManager, type ExtensionManager } from "./extension-manager.ts";
import { reportSettingsErrors } from "./watch-settings.ts";

type SettingsFiles<C> = { schema: SettingsSchema<C>; file: string };

type SettingsReload<C> = {
  reload(settings: C, info: SessionInfo, runtime: AgentRuntime, notify: (message: string) => void): void;
};

type ManagedSettings<C> = (SettingsFiles<C> | SettingsReload<C>) & { defaults(paths: ExtensionPaths): C };

type ManagedExtensionOptions<E extends EventMap, S, C> = {
  namespace: string;
  root: string;
  plugins: Plugin<E, S, C>[];
  host?: (host: Host) => Host;
  settings?: ManagedSettings<C>;
  childExclude?: string[];
  skillInventory?: boolean;
  disabled?: (settings: C) => Iterable<string>;
  onError?: (error: unknown, host: Host) => void;
};

type BootOverrides<C> = { settings?: Partial<C>; onError?: (error: unknown) => void };

export type ManagedExtension<E extends EventMap, S, C> = {
  boot(
    host: Host,
    runtime: AgentRuntime,
    paths: ExtensionPaths,
    overrides?: BootOverrides<C>,
  ): { manager: ExtensionManager<E, S>; settings: C };
  options: ManagedExtensionOptions<E, S, C> & { childExclude: string[] };
};

const rethrow = (error: unknown) => {
  throw error;
};

const watchManagedSettings = <C>(
  host: Host,
  runtime: AgentRuntime,
  label: string,
  spec: ManagedSettings<C>,
  paths: ExtensionPaths,
  overrides: Partial<C> = {},
): C => {
  const initial = spec.defaults(paths);
  const settings = Object.assign({}, initial, overrides);
  const report = reportSettingsErrors(host, label);

  const notify = (message: string) => {
    report([message]);
  };

  host.onSessionStart((info) => {
    if ("reload" in spec) {
      spec.reload(settings, info, runtime, notify);
    } else {
      const loaded = loadSettingsFiles(spec.schema, initial, spec.file, info);

      Object.assign(settings, loaded.settings);
      report(loaded.errors);
    }

    Object.assign(settings, overrides);
  });

  return settings;
};

export const createManagedExtension = <E extends EventMap, S, C = undefined>(
  options: ManagedExtensionOptions<E, S, C>,
): ReturnType<typeof createPiExtension> & ManagedExtension<E, S, C> => {
  const childExclude = (options.childExclude ?? []).map((entry) => resolve(options.root, entry));

  const boot: ManagedExtension<E, S, C>["boot"] = (piHost, runtime, paths, overrides = {}) => {
    const host = options.host ? options.host(piHost) : piHost;
    const settings = options.settings
      ? watchManagedSettings(host, runtime, options.namespace, options.settings, paths, overrides.settings)
      : (undefined as C);
    const onError = overrides.onError ?? ((error: unknown) => (options.onError ?? rethrow)(error, host));

    const manager = createExtensionManager({
      host,
      runtime,
      settings,
      plugins: options.plugins,
      paths,
      disabled: options.disabled?.(settings) ?? [],
      onError,
    });

    host.onSessionShutdown(async () => {
      await manager.disableAll();
    });

    return { manager, settings };
  };

  const factory = createPiExtension(boot, {
    root: options.root,
    namespace: options.namespace,
    childExclude,
    skillInventory: options.skillInventory,
  });

  return Object.assign(factory, { boot, options: { ...options, childExclude } });
};
