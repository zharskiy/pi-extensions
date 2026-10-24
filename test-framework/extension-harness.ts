import { createExtensionManager } from "../extension-manager/index.ts";
import type { AgentRuntime } from "../pi-adapter/index.ts";
import type { EventMap, Plugin } from "../shared/index.ts";
import { createFakeHost, type FakeHost } from "./fake-host.ts";

type ExtensionHarnessOptions<E extends EventMap, S, C, R extends AgentRuntime> = {
  plugins: Plugin<E, S, C>[];
  settings: C;
  root: string;
  runtime: R;
  host?: FakeHost;
  disabled?: Iterable<string>;
};

export const startExtension = <E extends EventMap, S, C, R extends AgentRuntime>(
  options: ExtensionHarnessOptions<E, S, C, R>,
) => {
  const { plugins, settings, root, runtime, host = createFakeHost(), disabled = [] } = options;
  const errors: unknown[] = [];

  const manager = createExtensionManager({
    host,
    runtime,
    settings,
    plugins,
    root,
    disabled,
    onError: (error) => errors.push(error),
  });

  host.start();

  return { root, host, runtime, settings, manager, errors, services: manager.services, bus: manager.bus };
};
