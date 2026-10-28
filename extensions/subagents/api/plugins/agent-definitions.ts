import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "../../../../platform/pi-adapter/index.ts";
import { type DefinitionDir, loadDefinitions } from "../../core/agent-definitions/loader.ts";
import { assemblePromptAppend } from "../../core/agent-definitions/prompt.ts";
import type { AgentDefinitions } from "../../core/model/agent-record.ts";
import { resolutionProblem } from "../../core/model/model-resolution.ts";
import { NAMESPACE, projectAgentsDir, userAgentsDir } from "../../core/model/paths.ts";
import type { Plugin } from "../../core/model/plugin.ts";
import { reloadSettings, settingsWarning } from "../../core/model/settings.ts";

export const agentDefinitionsPlugin: Plugin = {
  id: "agent-definitions",
  enable: ({ host, runtime, services, settings, paths }) => {
    const basePrompt = readFileSync(join(paths.root, "prompts", "base-system-prompt.md"), "utf8");
    const builtin: DefinitionDir = { path: join(paths.root, "agents"), source: "builtin" };
    const reported = new Set<string>();

    let loaded = loadDefinitions([builtin]);

    const notifyOnce = (message: string, level: "warning" | "info") => {
      if (!reported.has(message)) {
        reported.add(message);
        host.ui.notify(message, level);
      }
    };

    const modelChecker = () => {
      const problems = new Map<string, string | undefined>();

      return (model: string) => {
        if (!problems.has(model)) {
          const resolution = runtime.resolveModel(model);

          problems.set(model, resolution.kind === "resolved" ? undefined : resolutionProblem(resolution));
        }

        return problems.get(model);
      };
    };

    const load = (info: SessionInfo) => {
      const dirs: DefinitionDir[] = [builtin, { path: userAgentsDir(info), source: "user" }];
      const projectAgents = projectAgentsDir(info);

      if (info.projectTrusted) {
        dirs.push({ path: projectAgents, source: "project" });
      }

      loaded = loadDefinitions(dirs, {
        overrides: settings.agents,
        skillNames: () => runtime.skillNames(),
        modelProblem: modelChecker(),
        untrustedDir: info.projectTrusted ? undefined : projectAgents,
      });

      loaded.errors.forEach((error) => {
        notifyOnce(`${NAMESPACE}: invalid agent file ${error.path}: ${error.message}`, "warning");
      });

      loaded.warnings.forEach((warning) => {
        notifyOnce(`${NAMESPACE}: agent file ${warning.path}: ${warning.message}`, "warning");
      });

      loaded.notices.forEach((notice) => {
        notifyOnce(settingsWarning(notice.message), notice.level);
      });
    };

    const reload = () => {
      const info = host.session();

      reloadSettings(settings, info, runtime, (message) =>
        host.ui.notify(settingsWarning(message), "warning"),
      );
      load(info);
    };

    const definitions: AgentDefinitions = {
      get: (name) => loaded.definitions.get(name),
      list: () =>
        Array.from(loaded.definitions.values()).sort((left, right) => left.name.localeCompare(right.name)),
      promptAppend: (definition) => assemblePromptAppend(basePrompt, definition),
      reload,
    };

    services.provide("definitions", definitions);

    host.onSessionStart(load);
  },
};
