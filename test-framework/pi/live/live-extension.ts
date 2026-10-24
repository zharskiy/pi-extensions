import { basename, join } from "node:path";
import type { SkillFile } from "../../../pi-adapter/child/skills.ts";
import type { EventMap, Plugin } from "../../../shared/index.ts";
import { startExtension } from "../../extension-harness.ts";
import { createFakeHost, createTurnScope } from "../../fake-host.ts";
import { createLiveAgentRuntime } from "./live-runtime.ts";

export type LiveExtensionOptions<E extends EventMap, S, C> = {
  plugins: Plugin<E, S, C>[];
  settings: C;
  root: string;
  namespace: string;
  exclude: string[];
  workDir: string;
  trusted?: boolean;
  skillFiles?: SkillFile[];
  disabled?: Iterable<string>;
};

export const startLiveExtension = <E extends EventMap, S, C>(options: LiveExtensionOptions<E, S, C>) => {
  const project = join(options.workDir, "project");
  const agentDir = join(options.workDir, "agent");

  const runtime = createLiveAgentRuntime(
    { namespace: options.namespace, exclude: options.exclude },
    { trusted: options.trusted, skillFiles: options.skillFiles },
  );

  const host = createFakeHost({
    id: basename(options.workDir),
    file: join(options.workDir, "sessions", "main.jsonl"),
    cwd: project,
    agentDir,
    mode: "print",
  });

  const harness = startExtension({
    plugins: options.plugins,
    settings: options.settings,
    root: options.root,
    runtime,
    host,
    disabled: options.disabled,
  });

  return { ...harness, project, agentDir, turn: createTurnScope(host), close: () => host.shutdown() };
};
