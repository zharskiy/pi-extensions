import { basename, join } from "node:path";
import type { ManagedExtension } from "../../../../platform/extension-manager/index.ts";
import type { SkillInfo } from "../../../../platform/pi-adapter/index.ts";
import type { EventMap, Plugin } from "../../../../platform/shared/index.ts";
import { startExtension } from "../../extension-harness.ts";
import { createFakeHost, createTurnScope } from "../../fake-host.ts";
import { createLiveAgentRuntime } from "./live-runtime.ts";

type LiveRun = { workDir: string; trusted?: boolean; skillFiles?: SkillInfo[] };

type LivePlugins<E extends EventMap, S, C> = LiveRun & {
  plugins: Plugin<E, S, C>[];
  settings: C;
  root: string;
  namespace: string;
  exclude: string[];
  disabled?: Iterable<string>;
};

type LiveManaged<E extends EventMap, S, C> = LiveRun & {
  extension: ManagedExtension<E, S, C>;
  settings?: Partial<C>;
};

export type LiveExtensionOptions<E extends EventMap, S, C> = LivePlugins<E, S, C> | LiveManaged<E, S, C>;

const childScope = <E extends EventMap, S, C>(options: LiveExtensionOptions<E, S, C>) =>
  "extension" in options
    ? { namespace: options.extension.options.namespace, exclude: options.extension.options.childExclude }
    : { namespace: options.namespace, exclude: options.exclude };

export const startLiveExtension = <E extends EventMap, S, C>(options: LiveExtensionOptions<E, S, C>) => {
  const project = join(options.workDir, "project");
  const agentDir = join(options.workDir, "agent");

  const runtime = createLiveAgentRuntime(childScope(options), {
    trusted: options.trusted,
    skillFiles: options.skillFiles,
  });

  const host = createFakeHost({
    id: basename(options.workDir),
    file: join(options.workDir, "sessions", "main.jsonl"),
    cwd: project,
    agentDir,
    mode: "print",
  });

  const harness =
    "extension" in options
      ? startExtension({ extension: options.extension, settings: options.settings, runtime, host })
      : startExtension({
          plugins: options.plugins,
          settings: options.settings,
          root: options.root,
          runtime,
          host,
          disabled: options.disabled,
        });

  return { ...harness, project, agentDir, turn: createTurnScope(host), close: () => host.shutdown() };
};
