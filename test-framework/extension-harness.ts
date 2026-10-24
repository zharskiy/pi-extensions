import { createExtensionManager, type ManagedExtension } from "../extension-manager/index.ts";
import type { AgentRuntime } from "../pi-adapter/index.ts";
import type { EventMap, Plugin } from "../shared/index.ts";
import { createFakeHost, type FakeHost } from "./fake-host.ts";

type PluginsOptions<E extends EventMap, S, C, R extends AgentRuntime> = {
  plugins: Plugin<E, S, C>[];
  settings: C;
  root: string;
  runtime: R;
  host?: FakeHost;
  disabled?: Iterable<string>;
};

type ExtensionOptions<E extends EventMap, S, C, R extends AgentRuntime> = {
  extension: ManagedExtension<E, S, C>;
  settings?: Partial<C>;
  runtime: R;
  host?: FakeHost;
};

type ExtensionHarnessOptions<E extends EventMap, S, C, R extends AgentRuntime> =
  | PluginsOptions<E, S, C, R>
  | ExtensionOptions<E, S, C, R>;

const bootOn = <E extends EventMap, S, C, R extends AgentRuntime>(
  options: ExtensionHarnessOptions<E, S, C, R>,
  host: FakeHost,
  onError: (error: unknown) => void,
) => {
  if ("extension" in options) {
    const root = options.extension.options.root;
    const paths = { root, agentDir: host.info.agentDir };

    return {
      root,
      ...options.extension.boot(host, options.runtime, paths, { settings: options.settings, onError }),
    };
  }

  const { plugins, settings, root, runtime, disabled = [] } = options;
  const paths = { root, agentDir: host.info.agentDir };
  const manager = createExtensionManager({ host, runtime, settings, plugins, paths, disabled, onError });

  return { root, manager, settings };
};

export const startExtension = <E extends EventMap, S, C, R extends AgentRuntime>(
  options: ExtensionHarnessOptions<E, S, C, R>,
) => {
  const { runtime, host = createFakeHost() } = options;
  const errors: unknown[] = [];
  const { root, manager, settings } = bootOn(options, host, (error) => errors.push(error));

  host.start();

  return { root, host, runtime, settings, manager, errors, services: manager.services, bus: manager.bus };
};
